/**
 * 故障剧本注入 CLI
 *   npm run sim -- --list
 *   npm run sim -- --scenario=core-switch-board-failure [--seed=42]
 */
import { loadEnvFile } from 'node:process';
import { listScenarios, runScenario } from '@/modules/ingest/scenario';

try {
  loadEnvFile('.env');
} catch {
  // 环境变量已由外部注入
}

function argValue(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}

async function main() {
  if (process.argv.includes('--list')) {
    console.log('[sim] 可用剧本：');
    for (const name of listScenarios()) console.log(`  - ${name}`);
    return;
  }

  const scenario = argValue('scenario');
  if (!scenario) {
    console.error('[sim] 缺少 --scenario=<name>，用 --list 查看可用剧本');
    process.exitCode = 1;
    return;
  }

  const seedRaw = argValue('seed');
  const seed = seedRaw === undefined ? undefined : Number(seedRaw);
  if (seed !== undefined && !Number.isFinite(seed)) {
    console.error(`[sim] --seed 不是数字：${seedRaw}`);
    process.exitCode = 1;
    return;
  }

  const result = await runScenario(scenario, seed);
  const { ingest } = result;
  console.log(`[sim] 剧本 ${result.scenario} — ${result.title}`);
  console.log(
    `[sim] 告警 ${result.alertTotal} 条 → 新增 ${ingest.accepted} / 去重 ${ingest.deduped} / 抑制 ${ingest.suppressed} / 失败 ${ingest.failed}`,
  );
  console.log(`[sim] 变更记录 ${result.changes} 条 · runId=${result.runId}`);
  if (ingest.issues.length > 0) {
    console.log('[sim] 问题明细：');
    for (const issue of ingest.issues.slice(0, 10)) {
      console.log(`  - ${issue.deviceName ?? ''} ${issue.message}`);
    }
  }
  if (ingest.accepted === 0) {
    console.error('[sim] 没有任何告警入库，检查剧本里的设备名是否与种子数据一致');
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('[sim] 失败：', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
