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
  /** test 集清单哈希前 12 位：报告要能自证跑的是哪一版留出集 */
  manifest?: string;
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
  if (meta.manifest) {
    lines.push(
      `> 留出集清单哈希 \`${meta.manifest}\`（与 \`evals/dataset/test/MANIFEST.sha256\` 对应）`,
    );
  }
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
  lines.push(`| P95 研判耗时 | ${agg.p95DurationMs} ms | — | — |`);
  lines.push(
    `| REASONING 阶段均值 | ${agg.reasoning.avgMs} ms | < 6000 ms | ${verdict(agg.reasoning.avgMs < 6000)} |`,
  );
  lines.push(
    `| REASONING 阶段 P95 | ${agg.reasoning.p95Ms} ms | < 9000 ms | ${verdict(agg.reasoning.p95Ms < 9000)} |`,
  );
  lines.push(
    `| Top1 按来源拆分 | LLM ${agg.top1ByOrigin.LLM} · 规则补位 ${agg.top1ByOrigin.RULE_FALLBACK}${agg.top1ByOrigin.UNKNOWN > 0 ? ` · 未标注 ${agg.top1ByOrigin.UNKNOWN}` : ''} | — | 来源披露，不设独立门禁 |`,
  );
  lines.push(
    `| 朴素基线 Top1（最早告警设备 + 字典类别） | ${agg.hintOnlyTop1.hits}/${agg.hintOnlyTop1.total} | — | 参照值：接近上排说明提升可能来自题目本身 |`,
  );
  lines.push(
    `| 告警压缩比（整体） | ${agg.compression.toFixed(1)}:1 | ≥ 8:1 | ${verdict(agg.compression >= TARGETS.compression)} |`,
  );
  lines.push(
    `| 告警压缩比（按处理单元） | ${agg.compressionOnUserLoad.toFixed(1)}:1 | ≥ 8:1 | ${verdict(agg.compressionOnUserLoad >= TARGETS.compression)} |`,
  );
  lines.push(
    `| 压缩比理论上限 | ${agg.compressionCeiling.toFixed(1)}:1（按标注事件数） | — | 本集平均每个事件 ${(
      scores.reduce((sum, s) => sum + s.alertTotal, 0) /
      Math.max(
        1,
        scores.reduce((sum, s) => sum + s.expectIncidents, 0),
      )
    ).toFixed(1)} 条告警 |`,
  );
  lines.push(
    `| 压缩效率（实际 / 理论） | ${percent(agg.compressionEfficiency)} | ≥ 95% | ${verdict(agg.compressionEfficiency >= 0.95)} |`,
  );
  lines.push(
    `| 处理单元（事件 + 孤岛告警） | ${agg.handlingUnits}（${agg.orphanAlerts} 条孤岛） | — | — |`,
  );
  lines.push(
    `| 事件精确率 / 召回率 | ${percent(agg.precision)} / ${percent(agg.recall)} | ≥ 85% / ≥ 90% | ${verdict(agg.precision >= 0.85 && agg.recall >= 0.9)} |`,
  );
  lines.push(
    `| 根因告警误抑制率 | ${agg.rootAlertTotal === 0 ? '样本为空' : percent(agg.suppressionErrors / agg.rootAlertTotal)} | = 0 | ${verdict(agg.suppressionErrors === 0)} |`,
  );
  lines.push(
    `| 研判 token 用量 | ${agg.totalTokens === 0 ? '规则引擎（无 token）' : `${agg.totalTokens}`} | — | — |`,
  );
  lines.push(`| 全通过场景 | ${agg.passed}/${scores.length} | — | — |`);
  lines.push('');
  lines.push(
    '> 压缩比口径：绝对比值受数据集规模约束 —— 本集平均每个事件只有个位数告警，理论上限就低于 8:1，再完美的聚类也超不过它。判断压缩做得好不好看「压缩效率」，判断生产价值看真实数据规模下的绝对比值。',
  );
  lines.push('');

  lines.push('### 压缩比分组');
  lines.push('');
  lines.push('| 分组 | 场景数 | 告警 | 事件 | 压缩比 |');
  lines.push('| --- | --- | --- | --- | --- |');
  const KIND_LABEL: Record<string, string> = {
    POSITIVE: '正例',
    DISTRACTOR: '干扰例',
    ADVERSARIAL: '对抗例',
  };
  for (const [kind, ratio] of Object.entries(agg.compressionByKind)) {
    const group = scores.filter((s) => s.kind === kind);
    const a = group.reduce((sum, s) => sum + s.alertTotal, 0);
    const i = group.reduce((sum, s) => sum + s.incidentTotal, 0);
    if (group.length === 0) continue;
    lines.push(
      `| ${KIND_LABEL[kind] ?? kind} | ${group.length} | ${a} | ${i} | ${ratio.toFixed(1)}:1 |`,
    );
  }
  lines.push(
    `| 整体 | ${scores.length} | ${scores.reduce((sum, s) => sum + s.alertTotal, 0)} | ${scores.reduce((sum, s) => sum + s.incidentTotal, 0)} | ${agg.compression.toFixed(1)}:1 |`,
  );
  lines.push('');

  lines.push('### 拓扑完整度分组');
  lines.push('');
  lines.push('| 分组 | 场景数 | Top1 | Top3 | 告警 | 事件 | 压缩比 |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const [label, group] of [
    ['拓扑完整', agg.topology.full],
    ['部分 / 完全缺失', agg.topology.degraded],
  ] as const) {
    if (group.total === 0) continue;
    lines.push(
      `| ${label} | ${group.total} | ${group.top1}/${group.answerable} | ${group.top3}/${group.answerable} | ${group.alerts} | ${group.incidents} | ${group.compression.toFixed(1)}:1 |`,
    );
  }
  lines.push('');
  lines.push('> 期望 0 个事件的场景没有可评估的拓扑，不参与该分组。');
  lines.push('');

  lines.push('### 分层命中');
  lines.push('');
  lines.push('| 类别 | 场景数 | Top1 | Top3 |');
  lines.push('| --- | --- | --- | --- |');
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
