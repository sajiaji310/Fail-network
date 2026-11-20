import type { EvalAnswer, EvalCase } from './schema';
import type { TopologyLevel } from '../src/modules/topology/completeness';

/**
 * 评测打分（纯函数）。所有判定都只依赖传入的观测值，不碰数据库 ——
 * 这样打分规则本身可以被单测锁住，不会出现"跑分脚本改了，分数就悄悄变好"。
 */

export type ObservedHypothesis = {
  category: string;
  cause: string;
  confidence: number;
  /** 证据指向的设备名（由 run 阶段把 ref 解析成设备名后传入） */
  deviceRefs: string[];
};

export type ObservedAnalysis = {
  code: string;
  source: string;
  hypotheses: ObservedHypothesis[];
  dropped: number;
  rawEvidence: number;
  validEvidence: number;
  durationMs: number;
  /** 本次研判的 token 用量（规则引擎为 null；老数据可能没有这个字段） */
  tokensUsed?: number | null;
  topologyLevel?: TopologyLevel;
};

export type Observation = {
  alertTotal: number;
  /** 每个事件的设备名集合 */
  incidentDevices: string[][];
  /** 标注根因告警是否被抑制；case 未标注则为 null */
  rootAlertSuppressed: boolean | null;
  /** 没有进任何事件的活跃告警数：用户只能逐条看的"孤岛" */
  orphanAlerts: number;
  /** 整个场景的拓扑完整度（没有事件时为 null） */
  topologyLevel: TopologyLevel | null;
  analyses: ObservedAnalysis[];
};

export type CaseScore = {
  id: string;
  kind: EvalCase['kind'];
  title: string;
  note: string;
  alertTotal: number;
  incidentTotal: number;
  expectIncidents: number;
  /** 事件数与标注的吻合度：多生成为误报，少生成为漏报 */
  precision: number;
  recall: number;
  /** 标注根因设备是否落在某个事件里（聚合层是否抓到故障点） */
  deviceCovered: boolean;
  rootAlertSuppressed: boolean | null;
  top1: boolean;
  top3: boolean;
  /** 期望空结论且确实为空 */
  emptyCorrect: boolean;
  /** 期望有结论却给了空 */
  emptyButExpectedAnswer: boolean;
  /** 该 case 是否标注了根因（Top1/Top3 的分母只看它） */
  expectAnswer: boolean;
  hypothesisTotal: number;
  rawEvidence: number;
  validEvidence: number;
  durationMs: number;
  source: string | null;
  dropped: number;
  /** 未归入事件的孤岛告警：用户实际需要逐条处理的量 */
  orphanAlerts: number;
  /** 处理单元 = 事件数 + 孤岛告警数（评审 P0-3 第 2 条） */
  handlingUnits: number;
  /** 本次研判消耗的 token；规则引擎为 0 */
  tokens: number;
  topologyLevel: TopologyLevel | null;
  /** 人读的失败原因，空表示通过 */
  failures: string[];
};

function matched(hypothesis: ObservedHypothesis, answer: EvalAnswer): boolean {
  if (hypothesis.category !== answer.category) return false;
  // 假设没有结构化 device 字段（T07 的输出契约如此），两级匹配：
  // 先看证据指向的设备，再看结论文本里是否点了名。
  return hypothesis.deviceRefs.includes(answer.device) || hypothesis.cause.includes(answer.device);
}

/** 一个 case 的标注答案集合（主答案 + 等价答案） */
export function answersOf(kase: EvalCase): EvalAnswer[] {
  return kase.expect.rootCause ? [kase.expect.rootCause, ...kase.expect.alternatives] : [];
}

export function scoreCase(kase: EvalCase, obs: Observation): CaseScore {
  const answers = answersOf(kase);
  const expectAnswer = kase.expect.rootCause !== null;
  const hypotheses = obs.analyses.flatMap((a) => a.hypotheses);
  const top1List = obs.analyses.map((a) => a.hypotheses[0]).filter(Boolean);

  const hit = (list: (ObservedHypothesis | undefined)[]) =>
    answers.length > 0 && list.some((h) => h !== undefined && answers.some((a) => matched(h, a)));

  const top1 = hit(top1List.slice(0, 1));
  const top3 = hit([...top1List, ...hypotheses]);
  const emptyCorrect = !expectAnswer && hypotheses.length === 0;
  const emptyButExpectedAnswer = expectAnswer && hypotheses.length === 0;

  const deviceCovered =
    kase.expect.rootCause === null
      ? true
      : obs.incidentDevices.some((devices) => devices.includes(kase.expect.rootCause!.device));

  const incidentTotal = obs.incidentDevices.length;
  const expectIncidents = kase.expect.incidents;
  const precision =
    incidentTotal === 0
      ? expectIncidents === 0
        ? 1
        : 0
      : Math.min(1, expectIncidents / incidentTotal);
  const recall =
    expectIncidents === 0
      ? incidentTotal === 0
        ? 1
        : 0
      : Math.min(1, incidentTotal / expectIncidents);

  const failures: string[] = [];
  if (incidentTotal !== expectIncidents) {
    failures.push(`事件数 ${incidentTotal}，期望 ${expectIncidents}`);
  }
  if (!deviceCovered) failures.push(`事件未覆盖标注设备 ${kase.expect.rootCause?.device ?? '-'}`);
  if (emptyButExpectedAnswer) failures.push('期望有结论，实际为空（AC-20 反向）');
  if (!expectAnswer && hypotheses.length > 0) failures.push('期望空结论，实际给了假设');
  if (expectAnswer && !top3) failures.push('Top3 未命中标注根因');
  if (obs.rootAlertSuppressed === true) failures.push('标注根因告警被误抑制（AC-19）');

  return {
    id: kase.id,
    kind: kase.kind,
    title: kase.title,
    note: kase.note,
    alertTotal: obs.alertTotal,
    incidentTotal,
    expectIncidents,
    precision,
    recall,
    deviceCovered,
    rootAlertSuppressed: obs.rootAlertSuppressed,
    top1: expectAnswer ? top1 : emptyCorrect,
    top3: expectAnswer ? top3 : emptyCorrect,
    emptyCorrect,
    emptyButExpectedAnswer,
    expectAnswer,
    hypothesisTotal: hypotheses.length,
    rawEvidence: obs.analyses.reduce((sum, a) => sum + a.rawEvidence, 0),
    validEvidence: obs.analyses.reduce((sum, a) => sum + a.validEvidence, 0),
    durationMs: obs.analyses.reduce((sum, a) => sum + a.durationMs, 0),
    source: obs.analyses[0]?.source ?? null,
    dropped: obs.analyses.reduce((sum, a) => sum + a.dropped, 0),
    orphanAlerts: obs.orphanAlerts,
    handlingUnits: incidentTotal + obs.orphanAlerts,
    tokens: obs.analyses.reduce((sum, a) => sum + (a.tokensUsed ?? 0), 0),
    topologyLevel: obs.topologyLevel,
    failures,
  };
}

export type GroupStats = {
  total: number;
  answerable: number;
  top1: number;
  top3: number;
  alerts: number;
  incidents: number;
  compression: number;
};

export type Aggregate = {
  total: number;
  byKind: Record<EvalCase['kind'], { total: number; top1: number; top3: number }>;
  /**
   * 按场景类型拆开的压缩比（评审 P0-3 第 1 条）。
   * 一个总平均数会把"正例 7.5:1、对抗例 4.0:1"压成 6.0:1，看不出差在哪；
   * 小样本场景（3~4 条告警）在数学上就不可能达到 8:1，必须分组看。
   */
  compressionByKind: Record<EvalCase['kind'], number>;
  top1Rate: number;
  top3Rate: number;
  precision: number;
  recall: number;
  compression: number;
  /** 只统计正例场景的压缩比：对抗例里刻意构造的 2~3 条告警会稀释整体比值 */
  compressionOnPositive: number;
  /** 用户实际需要处理的单元 = 事件数 + 未归入事件的孤岛告警数（评审 P0-3 第 2 条） */
  handlingUnits: number;
  orphanAlerts: number;
  /** 压缩比按"处理单元"算，比按事件数算更贴近值班人的真实负担 */
  compressionOnUserLoad: number;
  /**
   * 压缩比的理论上限 = 告警总数 / 标注事件总数。
   *
   * 这是判断"压缩比低是系统的问题还是数据集的问题"的关键：如果每个事件平均
   * 只有 6 条告警，再完美的聚类也只能到 6:1。把上限和实际值并排放，
   * 就不用靠"目标 8:1"这种拍脑袋数字解释成败。
   */
  compressionCeiling: number;
  /** 压缩效率 = 标注事件数 / 实际事件数（封顶 1）：1 表示已经压到理论最优 */
  compressionEfficiency: number;
  /** 拓扑完整 / 部分或完全缺失 两组成绩（评审 P0-4） */
  topology: { full: GroupStats; degraded: GroupStats };
  answerable: number;
  /** 有标注根因的 case 数（Top1/Top3 的分母） */
  precisionDenominator: number;
  rootAlertTotal: number;
  suppressionErrors: number;
  /** 根因告警被误抑制的次数：每条都算 P0 失败（评审 P0-3 第 4 条） */
  criticalSuppressions: number;
  evidenceRate: number;
  avgDurationMs: number;
  p95DurationMs: number;
  totalTokens: number;
  fallbackRate: number;
  passed: number;
};

const round = (value: number): number => Math.round(value * 1000) / 1000;

function groupStats(list: readonly CaseScore[]): GroupStats {
  const alerts = list.reduce((sum, s) => sum + s.alertTotal, 0);
  const incidents = list.reduce((sum, s) => sum + s.incidentTotal, 0);
  return {
    total: list.length,
    answerable: list.filter((s) => s.expectAnswer).length,
    top1: list.filter((s) => s.expectAnswer && s.top1).length,
    top3: list.filter((s) => s.expectAnswer && s.top3).length,
    alerts,
    incidents,
    compression: round(incidents === 0 ? alerts : alerts / incidents),
  };
}

function compressionOf(list: readonly CaseScore[]): number {
  const alerts = list.reduce((sum, s) => sum + s.alertTotal, 0);
  const incidents = list.reduce((sum, s) => sum + s.incidentTotal, 0);
  return round(incidents === 0 ? alerts : alerts / incidents);
}

export function aggregate(scores: readonly CaseScore[]): Aggregate {
  const answerable = scores.filter((s) => s.expectAnswer);
  const withAnswer = answerable;
  const alerts = scores.reduce((sum, s) => sum + s.alertTotal, 0);
  const incidents = scores.reduce((sum, s) => sum + s.incidentTotal, 0);
  const raw = scores.reduce((sum, s) => sum + s.rawEvidence, 0);
  const valid = scores.reduce((sum, s) => sum + s.validEvidence, 0);
  const positive = scores.filter((s) => s.kind === 'POSITIVE');
  const positiveAlerts = positive.reduce((sum, s) => sum + s.alertTotal, 0);
  const positiveIncidents = positive.reduce((sum, s) => sum + s.incidentTotal, 0);
  const rootAlerts = scores.filter((s) => s.rootAlertSuppressed !== null);
  const orphanAlerts = scores.reduce((sum, s) => sum + s.orphanAlerts, 0);
  const handlingUnits = incidents + orphanAlerts;
  const expectedIncidents = scores.reduce((sum, s) => sum + s.expectIncidents, 0);

  const byKind: Aggregate['byKind'] = {
    POSITIVE: { total: 0, top1: 0, top3: 0 },
    DISTRACTOR: { total: 0, top1: 0, top3: 0 },
    ADVERSARIAL: { total: 0, top1: 0, top3: 0 },
  };
  for (const s of scores) {
    byKind[s.kind].total += 1;
    if (s.top1) byKind[s.kind].top1 += 1;
    if (s.top3) byKind[s.kind].top3 += 1;
  }

  const compressionByKind: Aggregate['compressionByKind'] = {
    POSITIVE: compressionOf(positive),
    DISTRACTOR: compressionOf(scores.filter((s) => s.kind === 'DISTRACTOR')),
    ADVERSARIAL: compressionOf(scores.filter((s) => s.kind === 'ADVERSARIAL')),
  };

  // 拓扑缺失的 case 才需要按缺失程度解释成绩；没有事件的场景（期望 0 个）不参与分组
  const topologyScored = scores.filter((s) => s.topologyLevel !== null);
  const full = topologyScored.filter((s) => s.topologyLevel === 'FULL');
  const degraded = topologyScored.filter((s) => s.topologyLevel !== 'FULL');

  const durations = scores
    .filter((s) => s.source !== null)
    .map((s) => s.durationMs)
    .sort((a, b) => a - b);
  const p95 =
    durations.length === 0 ? 0 : durations[Math.max(0, Math.ceil(durations.length * 0.95) - 1)]!;

  return {
    total: scores.length,
    byKind,
    compressionByKind,
    top1Rate: round(
      withAnswer.length === 0 ? 0 : withAnswer.filter((s) => s.top1).length / withAnswer.length,
    ),
    top3Rate: round(
      withAnswer.length === 0 ? 0 : withAnswer.filter((s) => s.top3).length / withAnswer.length,
    ),
    precision: round(scores.reduce((sum, s) => sum + s.precision, 0) / Math.max(1, scores.length)),
    recall: round(scores.reduce((sum, s) => sum + s.recall, 0) / Math.max(1, scores.length)),
    compression: round(incidents === 0 ? alerts : alerts / incidents),
    compressionOnPositive: round(
      positiveIncidents === 0 ? positiveAlerts : positiveAlerts / positiveIncidents,
    ),
    handlingUnits,
    orphanAlerts,
    compressionOnUserLoad: round(handlingUnits === 0 ? alerts : alerts / handlingUnits),
    compressionCeiling: round(expectedIncidents === 0 ? alerts : alerts / expectedIncidents),
    compressionEfficiency: round(
      expectedIncidents === 0 || incidents === 0 ? 1 : Math.min(1, expectedIncidents / incidents),
    ),
    topology: { full: groupStats(full), degraded: groupStats(degraded) },
    answerable: answerable.length,
    precisionDenominator: withAnswer.length,
    rootAlertTotal: rootAlerts.length,
    suppressionErrors: rootAlerts.filter((s) => s.rootAlertSuppressed).length,
    criticalSuppressions: rootAlerts.filter((s) => s.rootAlertSuppressed).length,
    evidenceRate: round(raw === 0 ? 0 : valid / raw),
    avgDurationMs: Math.round(
      scores.reduce((sum, s) => sum + s.durationMs, 0) /
        Math.max(1, scores.filter((s) => s.source).length),
    ),
    p95DurationMs: p95,
    totalTokens: scores.reduce((sum, s) => sum + s.tokens, 0),
    fallbackRate: round(
      scores.filter((s) => s.source === 'RULE_FALLBACK').length /
        Math.max(1, scores.filter((s) => s.source).length),
    ),
    passed: scores.filter((s) => s.failures.length === 0).length,
  };
}
