import { loadEnvFile } from 'node:process';
import { runRetention } from '../src/modules/system/retention';

try {
  loadEnvFile('.env');
} catch {
  // 容器内用环境变量注入时没有 .env，忽略
}

/**
 * 数据保留清理 CLI。
 *
 * 用法：
 *   npm run db:retention            # dry-run，只报数量
 *   npm run db:retention -- --run   # 真删
 *
 * 为什么不默认真删：这个脚本会被放进 crontab，参数写错一次就是半年审计没了。
 * 默认 dry-run，至少在日志里看一眼数量。
 */
async function main() {
  const run = process.argv.includes('--run');
  const report = await runRetention({ dryRun: !run });
  console.log(JSON.stringify(report, null, 2));
  if (report.dryRun) {
    console.log('\n[dry-run] 未删除任何数据。确认无误后加 --run 执行。');
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
