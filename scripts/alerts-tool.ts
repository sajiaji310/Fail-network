/**
 * 告警状态工具：存量重算 + 统计。
 * - `npm run alerts:recompute`：对库里已有的活跃父告警重跑 B9 回溯抑制（幂等）
 * - `npm run alerts:stats`：打印 ACTIVE/SUPPRESSED/RESOLVED 分布与抑制明细
 *
 * 为什么不直接清库重跑剧本：存量数据要能"就地验证"规则是否生效，
 * 重算路径与 ingest 路径共用同一套 suppress 实现，结果必须一致。
 */
import { loadEnvFile } from 'node:process';

try {
  loadEnvFile('.env');
} catch {
  // CI / docker 已由外部注入
}

async function main() {
  const { db } = await import('@/lib/db');
  const { getAlertStats } = await import('@/modules/alerts/service');
  const { suppressByParent } = await import('@/modules/alerts/suppress');
  const { PARENT_ALERT_TYPES } = await import('@/modules/alerts/taxonomy');

  const args = process.argv.slice(2);
  const recompute = args.includes('--recompute');

  if (recompute) {
    const parents = await db.alert.findMany({
      where: {
        status: 'ACTIVE',
        fingerprint: { type: { in: [...PARENT_ALERT_TYPES] } },
      },
      orderBy: { lastSeen: 'asc' },
      select: {
        id: true,
        fingerprint: { select: { type: true, device: { select: { name: true } } } },
      },
    });

    process.stdout.write(`[alerts] 活跃父告警 ${parents.length} 条\n`);
    let suppressed = 0;
    let autoClosed = 0;

    for (const parent of parents) {
      const outcome = await suppressByParent(parent.id);
      suppressed += outcome.suppressedAlertIds.length;
      autoClosed += outcome.affectedIncidents.filter((i) => i.closed).length;
      process.stdout.write(
        `[alerts]   ${parent.fingerprint.device.name} / ${parent.fingerprint.type} → 压制 ${outcome.suppressedAlertIds.length} 条\n`,
      );
    }

    process.stdout.write(`[alerts] 合计压制 ${suppressed} 条，自动关闭事件 ${autoClosed} 个\n`);
  }

  const stats = await getAlertStats();
  process.stdout.write(
    `[alerts] 状态分布：ACTIVE ${stats.active} · SUPPRESSED ${stats.suppressed} · RESOLVED ${stats.resolved} · 合计 ${stats.total}\n`,
  );
  process.stdout.write(`[alerts] 同周期折叠：${stats.collapsed} 次重复上报已并入既有行\n`);
  if (stats.suppressedByType.length > 0) {
    const detail = stats.suppressedByType.map((s) => `${s.type} ${s.count}`).join(' · ');
    process.stdout.write(`[alerts] 抑制明细：${detail}\n`);
  } else {
    process.stdout.write('[alerts] 当前没有处于 SUPPRESSED 的告警\n');
  }

  await db.$disconnect();
}

main().catch((error) => {
  process.stderr.write(
    `[alerts] 失败：${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
