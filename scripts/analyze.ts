/**
 * 研判工具：不起 web 也能跑一次根因研判，打印结论 + 校验统计。
 *
 * 用法：
 *   npm run rca:analyze -- --code=INC-20261119-001
 *   npm run rca:analyze -- --code=INC-20261119-001 --force     # 跳过 5 分钟缓存
 *   npm run rca:analyze -- --code=INC-20261119-001 --mock      # 用 fixture 假输出（演示 L1 丢弃）
 *   npm run rca:analyze -- --code=INC-20261119-001 --json      # 只输出 JSON，便于管道
 */
import { loadEnvFile } from 'node:process';

try {
  loadEnvFile('.env');
} catch {
  // CI / docker 已由外部注入
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function option(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

async function main() {
  const code = option('code');
  if (!code) {
    process.stderr.write(
      '用法：npm run rca:analyze -- --code=INC-YYYYMMDD-NNN [--force] [--mock] [--json]\n',
    );
    process.exit(1);
  }

  // LLM_MOCK 必须在 env.ts 首次求值前设置，所以要放在动态 import 之前
  if (flag('mock')) process.env.LLM_MOCK = 'true';

  const { runAnalysis } = await import('@/modules/rca/analyze');
  const { llmMode } = await import('@/lib/env');
  const { db } = await import('@/lib/db');

  const outcome = await runAnalysis(code, { force: flag('force') });
  if (!outcome) {
    process.stderr.write(`事件不存在：${code}\n`);
    await db.$disconnect();
    process.exit(1);
  }

  if (flag('json')) {
    process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
    await db.$disconnect();
    return;
  }

  const lines: string[] = [];
  lines.push(
    `[rca] ${outcome.code} · 模式 ${llmMode()} · 来源 ${outcome.source}${outcome.cached ? ' · 命中缓存' : ''}`,
  );
  if (outcome.degradedReason) lines.push(`[rca] 降级原因：${outcome.degradedReason}`);
  lines.push(`[rca] 结论：${outcome.summary ?? '（证据不足，未给出结论）'}`);
  if (outcome.impactScope) lines.push(`[rca] 影响面：${outcome.impactScope}`);
  lines.push(
    `[rca] 校验：证据 ${outcome.verify.stats.validEvidence}/${outcome.verify.stats.rawEvidence} 有效 · 丢弃假设 ${outcome.verify.dropped.length} 条`,
  );
  for (const drop of outcome.verify.dropped) {
    lines.push(`  - [${drop.reason}] ${drop.detail ?? drop.cause}`);
  }
  outcome.hypotheses.forEach((hypothesis, index) => {
    lines.push('');
    lines.push(`#${index + 1} ${hypothesis.cause}`);
    lines.push(`    类别 ${hypothesis.category} · 置信度 ${hypothesis.confidence}`);
    for (const item of hypothesis.evidence) {
      lines.push(`    证据 [${item.type}] ${item.ref} — ${item.desc}`);
    }
  });
  for (const info of outcome.missingInfo) {
    lines.push(`[rca] 缺失信息：${info}`);
  }

  process.stdout.write(`${lines.join('\n')}\n`);
  await db.$disconnect();
}

main().catch((error) => {
  process.stderr.write(`[rca] 失败：${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
