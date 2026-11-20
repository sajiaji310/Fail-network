import { isCaseRelevant, isDeviceRelated, SUSPICIOUS_CHANGE_GAP_MS } from './relevance';
import type { ContextBundle } from './context';
import type { Drop, HypothesisDraft, VerifyResult } from './schema';

/**
 * 证据校验器（文档 10.3）—— 三级，逐级加严。别叫它"反幻觉"：
 * 它能拦住"引用不存在的东西"（L1）和"引用存在但无关的东西"（L2），
 * 拦不住"证据都对但推理错了"。后者只能靠评测集与人工接受率。
 *
 * L1 存在性（硬）：ref 必须命中上下文清单里的真实 id → 否则整条假设丢弃
 * L2 相关性（硬）：告警/变更设备须在影响面内或 ≤2 跳；变更须早于首个告警；
 *                  链路须有一端在影响面；案例 tags 须与告警类型有交集 → 否则剔除该条证据
 * L3 一致性（软）：confidence *= 0.6 + 0.4 * 有效率；变更与告警间隔 < 60s 再 * 0.9
 */

export type VerifyContext = {
  incidentDeviceIds: ReadonlySet<string>;
  hop: (a: string, b: string) => number;
  firstAlertAtMs: number;
  alerts: Map<string, { deviceId: string; type: string }>;
  changes: Map<string, { deviceId: string; changedAtMs: number }>;
  links: Map<string, { sourceId: string; targetId: string }>;
  cases: Map<string, { tags: string[] }>;
  /** 指标证据：ref 形如 `metric:<设备名>:<指标>`，只校验设备是否相关 */
  metrics: Map<string, { deviceId: string }>;
  alertTypes: string[];
};

export function buildVerifyContext(ctx: ContextBundle): VerifyContext {
  return {
    incidentDeviceIds: new Set(ctx.nodes.map((n) => n.id)),
    hop: ctx.graph.hop,
    firstAlertAtMs: new Date(ctx.incident.firstAlertAt).getTime(),
    alerts: new Map(ctx.alerts.map((a) => [a.id, { deviceId: a.deviceId, type: a.type }])),
    changes: new Map(
      ctx.changes.map((c) => [
        c.id,
        { deviceId: c.deviceId, changedAtMs: new Date(c.changedAt).getTime() },
      ]),
    ),
    links: new Map(ctx.links.map((l) => [l.id, { sourceId: l.sourceId, targetId: l.targetId }])),
    cases: new Map(ctx.cases.map((c) => [c.id, { tags: c.tags }])),
    metrics: new Map(ctx.metrics.map((m) => [m.ref, { deviceId: m.deviceId }])),
    alertTypes: [...new Set(ctx.alerts.map((a) => a.type))],
  };
}

function existsInContext(ctx: VerifyContext, type: string, ref: string): boolean {
  switch (type) {
    case 'ALERT':
      return ctx.alerts.has(ref);
    case 'CHANGE':
      return ctx.changes.has(ref);
    case 'TOPOLOGY':
      return ctx.links.has(ref);
    case 'CASE':
      return ctx.cases.has(ref);
    case 'METRIC':
      return ctx.metrics.has(ref);
    default:
      return false;
  }
}

/** L2：单条证据是否与本次事件相关 */
export function isEvidenceRelevant(ctx: VerifyContext, type: string, ref: string): boolean {
  switch (type) {
    case 'ALERT': {
      const alert = ctx.alerts.get(ref);
      if (!alert) return false;
      return isDeviceRelated(alert.deviceId, ctx.incidentDeviceIds, ctx.hop);
    }
    case 'CHANGE': {
      const change = ctx.changes.get(ref);
      if (!change) return false;
      if (change.changedAtMs >= ctx.firstAlertAtMs) return false; // 后发生的变更不能当原因
      return isDeviceRelated(change.deviceId, ctx.incidentDeviceIds, ctx.hop);
    }
    case 'TOPOLOGY': {
      const link = ctx.links.get(ref);
      if (!link) return false;
      // 文档原文：链路两端至少一端 ∈ 事件设备集
      return ctx.incidentDeviceIds.has(link.sourceId) || ctx.incidentDeviceIds.has(link.targetId);
    }
    case 'CASE': {
      const item = ctx.cases.get(ref);
      if (!item) return false;
      return isCaseRelevant(item.tags, ctx.alertTypes);
    }
    case 'METRIC': {
      const metric = ctx.metrics.get(ref);
      if (!metric) return false;
      // 指标与告警同一条判定：设备要在影响面内（或 ≤2 跳），否则"隔壁机房的 CPU"也能当证据
      return isDeviceRelated(metric.deviceId, ctx.incidentDeviceIds, ctx.hop);
    }
    default:
      return false;
  }
}

/** 是否存在"变更就在告警前 60 秒内"的巧合（L3 额外降权信号） */
function hasSuspiciousChangeGap(ctx: VerifyContext, refs: readonly string[]): boolean {
  for (const ref of refs) {
    const change = ctx.changes.get(ref);
    if (!change) continue;
    const gap = ctx.firstAlertAtMs - change.changedAtMs;
    if (gap >= 0 && gap < SUSPICIOUS_CHANGE_GAP_MS) return true;
  }
  return false;
}

export function verifyHypotheses(
  drafts: readonly HypothesisDraft[],
  ctx: VerifyContext,
): VerifyResult {
  const kept: HypothesisDraft[] = [];
  const dropped: Drop[] = [];
  let rawEvidence = 0;
  let validEvidence = 0;

  for (const draft of drafts) {
    const raw = draft.evidence.length;
    rawEvidence += raw;

    if (raw === 0) {
      // zod 已挡掉（min 1），这里是防御性分支，防上层绕过 schema 直接调用
      dropped.push({ cause: draft.cause, reason: 'NO_EVIDENCE', detail: '假设未附带任何证据' });
      continue;
    }

    const missing = draft.evidence.filter((e) => !existsInContext(ctx, e.type, e.ref));
    if (missing.length > 0) {
      // L1 是硬性：整条丢弃而不是剔除单条证据 —— 一条假设的推理链是靠证据串起来的，
      // 去掉一环后剩下的证据未必还支撑同一个结论。
      dropped.push({
        cause: draft.cause,
        reason: 'EVIDENCE_NOT_FOUND',
        detail: `引用了不存在的证据：${missing.map((e) => `${e.type}:${e.ref}`).join(', ')}`,
      });
      continue;
    }

    const relevant = draft.evidence.filter((e) => isEvidenceRelevant(ctx, e.type, e.ref));
    validEvidence += relevant.length;

    if (relevant.length === 0) {
      dropped.push({
        cause: draft.cause,
        reason: 'EVIDENCE_IRRELEVANT',
        detail: `证据均与本次事件无关：${draft.evidence.map((e) => e.ref).join(', ')}`,
      });
      continue;
    }

    const ratio = relevant.length / raw;
    let confidence = draft.confidence * (0.6 + 0.4 * ratio);
    if (
      hasSuspiciousChangeGap(
        ctx,
        relevant.map((e) => e.ref),
      )
    ) {
      confidence *= 0.9;
    }

    kept.push({
      ...draft,
      evidence: relevant,
      confidence: Math.round(Math.min(1, Math.max(0, confidence)) * 1000) / 1000,
    });
  }

  // 证据被削过的假设可能从第 1 掉到第 2，重排一次顺序更诚实
  kept.sort((a, b) => b.confidence - a.confidence);

  return {
    kept,
    dropped,
    stats: {
      rawEvidence,
      validEvidence,
      relevanceRate:
        rawEvidence === 0 ? 0 : Math.round((validEvidence / rawEvidence) * 1000) / 1000,
    },
  };
}
