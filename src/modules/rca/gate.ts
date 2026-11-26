import { isExplainedType } from './explainability';
import type { ContextBundle } from './context';
import type { HypothesisDraft } from './schema';

/**
 * 两段式拒答门禁（Spec 0.2 §3.3）。名字叫"门禁"而不是"过滤器"，因为它拦的是**结论本身**：
 *
 *   R1（前置，调模型之前）：所有告警类型都没登记、且没有任何事件前变更
 *       → 这次事件里没有任何"可归因"的东西，模型再聪明也只能编。
 *       直接走规则引擎（它自己会返回空结论），一次模型都不调，省掉一次 7 秒的等待。
 *
 *   GATE-02（后置，证据校验之后）：逐条假设检查"有没有可归因证据"。
 *       只认两种：ALERT（且类型已登记）、CHANGE（且早于首个告警）。
 *       拓扑/指标/历史案例**一律不算** —— 它们能说明"哪里受影响"，不能说明"为什么"。
 *       放宽这条等于让"只引了一条链路 + 一条曲线"的假设过门，而那正是 F2 失败的形态。
 *
 * 两个函数都是纯的：不读 env、不碰数据库。`RCA_GATE=off` 由调用方跳过调用（一键回滚）。
 */

/** 前置门禁命中时的降级文案（Spec §3.3 原文，落进 degradedReason） */
export const R1_REASON = '闸门 R1：全部告警类型未登记且无事件前变更，证据不足以归因';

/** GATE-02 清空原因前缀：missingInfo 里要能一眼看出是门禁清的，不是校验器清的 */
export const GATE02_REASON_PREFIX = '闸门 GATE-02：';

export type PreGateDecision = {
  /** true = 不要调用模型，直接走规则引擎 */
  abstain: boolean;
  /** 命中原因（abstain=false 时为 null） */
  reason: string | null;
};

/**
 * 前置 R1。三个条件必须同时成立才拒答：
 *
 *   1. 有告警（没有告警的事件连"看不懂"的东西都没有，不归它管）；
 *   2. 每一条告警的类型都未登记（只要有一条能归因，模型就有起点）；
 *   3. 没有任何早于首个告警的变更（变更本身就是可归因证据）。
 *
 * 刻意不检查"告警条数是否过薄"：生产上低置信结论比拒答有用，R3 已在 Spec §2.2 被否。
 */
export function shouldAbstainBeforeModel(ctx: ContextBundle): PreGateDecision {
  if (ctx.alerts.length === 0) return { abstain: false, reason: null };
  if (!ctx.alerts.every((alert) => !isExplainedType(alert.type))) {
    return { abstain: false, reason: null };
  }
  if (ctx.changes.some((change) => change.beforeFirstAlert)) {
    return { abstain: false, reason: null };
  }
  return { abstain: true, reason: R1_REASON };
}

export type ClearedHypothesis = {
  cause: string;
  reason: string;
  detail: string;
};

export type GateResult = {
  kept: HypothesisDraft[];
  cleared: ClearedHypothesis[];
};

export type GateInput = {
  hypotheses: readonly HypothesisDraft[];
  ctx: ContextBundle;
};

/** 单条证据是否"可归因"：ALERT（已登记类型）| CHANGE（早于首个告警）。其余类型一律不算 */
function isAttributable(
  type: string,
  ref: string,
  alertTypeById: Map<string, string>,
  changeBeforeById: Map<string, boolean>,
): boolean {
  if (type === 'ALERT') {
    const alertType = alertTypeById.get(ref);
    return alertType !== undefined && isExplainedType(alertType);
  }
  if (type === 'CHANGE') {
    return changeBeforeById.get(ref) === true;
  }
  // TOPOLOGY / METRIC / CASE：能证明"有关联"，不能证明"是原因"
  return false;
}

/**
 * 后置 GATE-02：没有可归因证据的假设整条清空（不是剔除那条证据）。
 *
 * 与校验器 L1 同一个立场：一条假设的推理链靠证据串起来，抽掉承重的那一条之后，
 * 剩下的部分未必还支撑同一个结论，留着它只会让值班人看到一个自己都不成立的判断。
 */
export function gateHypotheses(input: GateInput): GateResult {
  const alertTypeById = new Map(input.ctx.alerts.map((a) => [a.id, a.type]));
  const changeBeforeById = new Map(input.ctx.changes.map((c) => [c.id, c.beforeFirstAlert]));

  const kept: HypothesisDraft[] = [];
  const cleared: ClearedHypothesis[] = [];

  for (const hypothesis of input.hypotheses) {
    const attributable = hypothesis.evidence.some((e) =>
      isAttributable(e.type, e.ref, alertTypeById, changeBeforeById),
    );
    if (attributable) {
      kept.push(hypothesis);
      continue;
    }
    const onlyTypes = [...new Set(hypothesis.evidence.map((e) => e.type))].join('/');
    cleared.push({
      cause: hypothesis.cause,
      reason: `${GATE02_REASON_PREFIX}无可归因证据`,
      detail: `证据仅由 ${onlyTypes} 构成，既无已登记告警也无可作原因的事件前变更`,
    });
  }

  return { kept, cleared };
}

/** 门禁清空原因转成给人看的一句话，进 missingInfo（与原有缺失项取并集后截断 5 条） */
export function clearanceMissingInfo(cleared: readonly ClearedHypothesis[]): string[] {
  return cleared.map((item) => {
    const brief = item.cause.length > 20 ? `${item.cause.slice(0, 20)}…` : item.cause;
    return `${item.reason}（${brief}）`;
  });
}
