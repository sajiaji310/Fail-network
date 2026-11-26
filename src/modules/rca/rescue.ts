import { rcaGateEnabled, rcaRescueEnabled } from '@/lib/env';
import type { ContextBundle } from './context';
import { ruleFallback } from './fallback';
import type { HypothesisDraft } from './schema';

/**
 * 空结论补位（Spec 0.2 §3.4）。
 *
 * 场景：模型答了、schema 也过了，但校验器 + GATE-02 把它的假设全清空。
 * 此时页面上只剩一句"证据不足"，而规则引擎明明能从变更时间与拓扑距离给出候选。
 * 补位就是把这份候选接上 —— 但只在**模型已经失手**时接，且**逐条标明来源**：
 * 值班人看到的每一行都要知道它是模型说的还是规则算的，否则"提升"无法归因。
 *
 * 三条边界（越界即作弊）：
 *   1. 只有 `kept` 为空、且本次确实是模型路径（source=LLM）才补。
 *      规则引擎自己给的空结论就是空结论，不自我重复、不"再想想"。
 *   2. 规则引擎也返回空（如 R1 场景）时保持空，**不得**为凑数编造。
 *   3. 补位后 source 落 RULE_FALLBACK 而不是 LLM：KPI 与前端角标都按二值判断。
 */

export type HypothesisOrigin = 'LLM' | 'RULE_FALLBACK';

export const RESCUE_REASON = '模型未给出可用结论，已由规则引擎补位';

export type RescueInput = {
  ctx: ContextBundle;
  /** 门禁之后仍保留的假设 */
  kept: readonly HypothesisDraft[];
  source: HypothesisOrigin;
  degradedReason: string | null;
  summary: string | null;
  impactScope: string | null;
  missingInfo: readonly string[];
};

export type RescueResult = {
  hypotheses: HypothesisDraft[];
  source: HypothesisOrigin;
  degradedReason: string | null;
  summary: string | null;
  impactScope: string | null;
  missingInfo: string[];
  /** 与 hypotheses 一一对应的来源标记（Spec §3.4 要求逐条） */
  origin: HypothesisOrigin[];
  rescued: boolean;
};

/** 假设的"主设备"：第一条 ALERT 证据指向的设备。去重键用它，不用 category 单独去重 */
function primaryDeviceOf(
  hypothesis: HypothesisDraft,
  deviceNameByAlertId: Map<string, string>,
): string | null {
  for (const item of hypothesis.evidence) {
    if (item.type !== 'ALERT') continue;
    return deviceNameByAlertId.get(item.ref) ?? null;
  }
  return null;
}

/**
 * 去重键 `category|主设备名`：同类别同设备的两条候选，对值班人是同一个待查对象。
 * 主设备取该假设第一条 ALERT 证据指向的设备 —— 没有 ALERT 证据的假设（纯变更类）
 * 主设备为空串，按类别去重，不会把上游变更与下游链路塌成同一条。
 */
export function dedupeByCategoryAndDevice(
  hypotheses: readonly HypothesisDraft[],
  ctx: ContextBundle,
): HypothesisDraft[] {
  const deviceNameByAlertId = new Map(ctx.alerts.map((a) => [a.id, a.deviceName]));
  const seen = new Set<string>();
  const kept: HypothesisDraft[] = [];
  for (const hypothesis of hypotheses) {
    const key = `${hypothesis.category}|${primaryDeviceOf(hypothesis, deviceNameByAlertId) ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(hypothesis);
  }
  return kept;
}

export function rescueEmptyResult(input: RescueInput): RescueResult {
  const passthrough: RescueResult = {
    hypotheses: [...input.kept],
    source: input.source,
    degradedReason: input.degradedReason,
    summary: input.summary,
    impactScope: input.impactScope,
    missingInfo: [...input.missingInfo],
    origin: input.kept.map(() => input.source),
    rescued: false,
  };

  if (input.kept.length > 0) return passthrough;
  if (input.source !== 'LLM') return passthrough;
  // RCA_GATE=off 的语义是"回到 0.1 行为"，补位属于 0.2 的一部分，必须跟着一起关。
  // 否则运维以为关掉门禁就回滚了，实际还留着一个会改 source 的补位在跑。
  if (!rcaGateEnabled()) return passthrough;
  if (!rcaRescueEnabled()) return passthrough;

  const rule = ruleFallback(input.ctx);
  // 规则引擎也没得说 → 保持空结论。这里多给一条"候选"就是对 AC-20 的背叛
  if (rule.hypotheses.length === 0) return passthrough;

  const hypotheses = dedupeByCategoryAndDevice(rule.hypotheses, input.ctx);
  if (hypotheses.length === 0) return passthrough;

  return {
    hypotheses,
    source: 'RULE_FALLBACK',
    degradedReason: RESCUE_REASON,
    summary: rule.summary,
    impactScope: rule.impactScope,
    missingInfo: [...new Set([...input.missingInfo, ...rule.missingInfo])].slice(0, 5),
    origin: hypotheses.map(() => 'RULE_FALLBACK'),
    rescued: true,
  };
}
