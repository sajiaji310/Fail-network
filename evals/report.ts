import type { Aggregate, CaseScore } from './metrics';

/**
 * 评测报告渲染：Markdown 直接贴 README。
 * 纯函数，不读文件、不打时间戳（时间由调用方传入），这样单测结果稳定。
 */

export type RunMeta = {
  set: string;
  mode: string;
  startedAt: string;
  durationMs: number;
};

export type EvalReport = {
  meta: RunMeta;
  scores: CaseScore[];
  agg: Aggregate;
};

const percent = (value: number): string => `${(value * 100).toFixed(1)}%`;

function verdict(ok: boolean): string {
  return ok ? '✅' : '❌';
}

const TARGETS = {
  top1: 0.5,
  top3: 0.8,
  evidence: 0.95,
  compression: 8,
} as const;

export function renderMarkdown(report: EvalReport): string {
  const { meta, scores, agg } = report;
  const lines: string[] = [];

  lines.push(`## 评测结果 · ${meta.set} 集`);
  lines.push('');
  lines.push(
    `> ${scores.length} 个场景 · 推理模式 \`${meta.mode}\` · 跑于 ${meta.startedAt} · 用时 ${(meta.durationMs / 1000).toFixed(1)}s`,
  );
  lines.push('');
  lines.push('| 指标 | 结果 | 目标 | 判定 |');
  lines.push('| --- | --- | --- | --- |');
  lines.push(
    `| Top1 命中率 | ${percent(agg.top1Rate)} (${scores.filter((s) => s.top1 && s.expectAnswer).length}/${agg.precisionDenominator}) | ≥ ${percent(TARGETS.top1)} | ${verdict(agg.top1Rate >= TARGETS.top1)} |`,
  );
  lines.push(
    `| Top3 命中率 | ${percent(agg.top3Rate)} (${scores.filter((s) => s.top3 && s.expectAnswer).length}/${agg.precisionDenominator}) | ≥ ${percent(TARGETS.top3)} | ${verdict(agg.top3Rate >= TARGETS.top3)} |`,
  );
  lines.push(`| 证据相关率（L2 后） | ${percent(agg.evidenceRate)} | 基线，不设目标 | — |`);
  lines.push(
    `| 平均研判耗时 | ${agg.avgDurationMs} ms | < 8000 ms | ${verdict(agg.avgDurationMs < 8000)} |`,
  );
  lines.push(
    `| 告警压缩比 | ${agg.compression.toFixed(1)}:1 | ≥ 8:1 | ${verdict(agg.compression >= TARGETS.compression)} |`,
  );
  lines.push(
    `| 告警压缩比（仅正例） | ${agg.compressionOnPositive.toFixed(1)}:1 | ≥ 8:1 | ${verdict(agg.compressionOnPositive >= TARGETS.compression)} |`,
  );
  lines.push(
    `| 事件精确率 / 召回率 | ${percent(agg.precision)} / ${percent(agg.recall)} | ≥ 85% / ≥ 90% | ${verdict(agg.precision >= 0.85 && agg.recall >= 0.9)} |`,
  );
  lines.push(
    `| 根因告警误抑制率 | ${agg.rootAlertTotal === 0 ? '样本为空' : percent(agg.suppressionErrors / agg.rootAlertTotal)} | = 0 | ${verdict(agg.suppressionErrors === 0)} |`,
  );
  lines.push(`| 全通过场景 | ${agg.passed}/${scores.length} | — | — |`);
  lines.push('');

  lines.push('### 分层命中');
  lines.push('');
  lines.push('| 类别 | 场景数 | Top1 | Top3 |');
  lines.push('| --- | --- | --- | --- |');
  const KIND_LABEL: Record<string, string> = {
    POSITIVE: '正例',
    DISTRACTOR: '干扰例',
    ADVERSARIAL: '对抗例',
  };
  for (const [kind, item] of Object.entries(agg.byKind)) {
    if (item.total === 0) continue;
    lines.push(
      `| ${KIND_LABEL[kind] ?? kind} | ${item.total} | ${item.top1}/${item.total} | ${item.top3}/${item.total} |`,
    );
  }
  lines.push('');

  lines.push('### 逐场景');
  lines.push('');
  lines.push('| 场景 | 类型 | 告警 | 事件（期望） | Top1 | Top3 | 证据率 | 耗时 | 结果 |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const s of scores) {
    const evidence = s.rawEvidence === 0 ? '—' : percent(s.validEvidence / s.rawEvidence);
    lines.push(
      `| ${s.id} ${s.title} | ${KIND_LABEL[s.kind] ?? s.kind} | ${s.alertTotal} | ${s.incidentTotal}（${s.expectIncidents}） | ${s.expectAnswer ? (s.top1 ? '✅' : '❌') : '—'} | ${s.expectAnswer ? (s.top3 ? '✅' : '❌') : '—'} | ${evidence} | ${s.durationMs}ms | ${s.failures.length === 0 ? '✅' : '❌'} |`,
    );
  }
  lines.push('');

  const failed = scores.filter((s) => s.failures.length > 0);
  if (failed.length > 0) {
    lines.push('### 失败明细');
    lines.push('');
    for (const s of failed) {
      lines.push(`- **${s.id}**（${s.title}）：${s.failures.join('；')}`);
      lines.push(`  - 考点：${s.note}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
