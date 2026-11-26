/**
 * 聚合工具：手动跑一次关联聚合，打印新建/沿用/重开/合并明细。
 *
 * 用途有两个：
 * 1) 验收时不用起 web 也能看到聚合结果；
 * 2) 复现幂等性 —— 连续跑两次，created/updated 的 id 必须完全一致。
 */
import { loadEnvFile } from 'node:process';

try {
  loadEnvFile('.env');
} catch {
  // CI / docker 已由外部注入
}

async function main() {
  const { db } = await import('@/lib/db');
  const { runCorrelation } = await import('@/modules/correlation/service');
  const { replayCorrelation } = await import('@/modules/correlation/replay');

  const fromArg = process.argv.find((arg) => arg.startsWith('--from='));
  const toArg = process.argv.find((arg) => arg.startsWith('--to='));
  if (Boolean(fromArg) !== Boolean(toArg)) {
    throw new Error('回放需要同时给出 --from=ISO8601 和 --to=ISO8601');
  }

  if (fromArg && toArg) {
    const summary = await replayCorrelation({
      from: new Date(fromArg.slice('--from='.length)),
      to: new Date(toArg.slice('--to='.length)),
    });
    const out = [
      `[corr] 回放 ${summary.from} → ${summary.to} · ${summary.steps} 步 · 耗时 ${summary.durationMs}ms`,
      `[corr]   新建 ${summary.created.length} · 沿用 ${summary.updated.length} · 重开 ${summary.reopened.length} · 收敛 ${summary.converged.length} · 合并 ${summary.merged.length}`,
    ];
    for (const incident of summary.created) {
      out.push(`[corr]   + 新建 ${incident.code}  ${incident.alerts} 条告警`);
    }
    process.stdout.write(`${out.join('\n')}\n`);
    await db.$disconnect();
    return;
  }

  const now = new Date();
  const s = await runCorrelation(now);

  const out: string[] = [];
  out.push(
    `[corr] 候选告警 ${s.consideredAlerts} 条（未归属 ${s.freshAlerts}）· 簇 ${s.clusters} 个 · 噪声告警 ${s.noiseAlerts} · 耗时 ${s.durationMs}ms`,
  );

  for (const i of s.created) out.push(`[corr]   + 新建 ${i.code}  ${i.alerts} 条告警`);
  for (const i of s.updated) out.push(`[corr]   ~ 沿用 ${i.code}  +${i.added} 条`);
  for (const i of s.reopened) out.push(`[corr]   * 重开 ${i.code}  第 ${i.reopenedCount} 次`);
  for (const i of s.merged) {
    out.push(`[corr]   = 合并 ${i.from} → ${i.into}  迁移 ${i.movedAlerts} 条`);
  }

  if (s.created.length + s.updated.length + s.reopened.length + s.merged.length === 0) {
    out.push('[corr] 本次无变更（幂等：重复执行不会重复建事件）');
  }

  const [incidents, active, alerts] = await Promise.all([
    db.incident.count(),
    db.incident.count({ where: { status: { in: ['OPEN', 'ANALYZING', 'LOCATED', 'MITIGATED'] } } }),
    db.alert.count({ where: { status: 'ACTIVE' } }),
  ]);
  out.push(`[corr] 库内事件 ${incidents} 个（活跃 ${active}）· 有效告警 ${alerts} 条`);

  process.stdout.write(`${out.join('\n')}\n`);
  await db.$disconnect();
}

main().catch((error) => {
  process.stderr.write(`[corr] 失败：${String(error)}\n`);
  process.exit(1);
});
