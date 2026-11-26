import { db } from '@/lib/db';
import { llmMode, rcaGateEnabled, rcaHintEnabled, type LlmMode } from '@/lib/env';
import { createLogger } from '@/lib/logger';
import { capConfidence } from '@/modules/topology/completeness';
import { buildIncidentContext } from './context';
import { clearanceMissingInfo, gateHypotheses } from './gate';
import { persistAnalysis } from './persist';
import { produceResult } from './produce';
import {
  beginAnalysis,
  enterStage,
  failAnalysis,
  finishAnalysis,
  type AnalysisProgress,
} from './progress';
import { PROMPT_VERSION } from './prompt';
import {
  AnalysisResultSchema,
  parseAnalysisMeta,
  type AnalysisMeta,
  type Drop,
  type HypothesisDraft,
} from './schema';
import { buildVerifyContext, verifyHypotheses } from './verify';

/**
 * 研判编排（文档 4.1 步 4~6 + 10.4 调用策略）。
 *
 *   context → (规则 fallback | 前置 R1 | LLM) → zod 校验 → L1/L2/L3 → GATE-02 → 落库
 *
 * 三条不能让步的约束：
 *   1. 无 key 全链路可用（AC-07）：fallback 不是"出错时的兜底"，而是一等公民；
 *   2. 模型输出不合 schema 就修复一次，再不合就降级，绝不把半成品塞给前端；
 *   3. 校验后若一条不剩，落空摘要 + missingInfo（AC-20），不留上一轮结论。
 *
 * 0.2 起"产出"这一段搬去 `produce.ts`（含前置门禁与止损），本文件只负责编排与落库。
 */

export const ANALYSIS_CACHE_MS = 5 * 60 * 1000;

const log = createLogger('rca');

export type AnalysisOutcome = {
  incidentId: string;
  code: string;
  source: 'LLM' | 'RULE_FALLBACK';
  model: string | null;
  /** 命中 5 分钟缓存：本次没有真的调用模型 */
  cached: boolean;
  summary: string | null;
  impactScope: string | null;
  hypotheses: HypothesisDraft[];
  missingInfo: string[];
  /** 本次（或缓存那次）的 token 用量，评测算成本用 */
  tokensUsed: number | null;
  /** 研判时的拓扑完整度，评测按它分组统计 */
  topologyLevel: 'FULL' | 'PARTIAL' | 'MISSING';
  verify: {
    dropped: Drop[];
    stats: { rawEvidence: number; validEvidence: number; relevanceRate: number };
  };
  trim: string[];
  degradedReason: string | null;
  analyzedAt: string;
  /** 本次研判的阶段耗时（评审第 3 阶段）：命中缓存时为 null */
  progress?: AnalysisProgress | null;
  /** 后置门禁 GATE-02 清空了几条、为什么（Spec §3.3）：命中缓存时为 undefined */
  gate?: { cleared: number; reasons: string[] };
};

/** 从库里读回上一次研判（命中缓存时不再调用模型） */
async function readCachedAnalysis(
  idOrCode: string,
  tenantId = 'default',
): Promise<AnalysisOutcome | null> {
  const row = await db.incident.findFirst({
    where: { tenantId, OR: [{ id: idOrCode }, { code: idOrCode }] },
    select: {
      id: true,
      code: true,
      summary: true,
      impactScope: true,
      analysisMeta: true,
      hypotheses: {
        orderBy: { rank: 'asc' },
        select: {
          cause: true,
          category: true,
          confidence: true,
          evidence: true,
          verifySteps: true,
          actions: true,
        },
      },
    },
  });
  if (!row || row.hypotheses.length === 0) return null;

  const meta = parseAnalysisMeta(row.analysisMeta);
  if (!meta) return null;
  const analyzedAtMs = new Date(meta.analyzedAt).getTime();
  if (!Number.isFinite(analyzedAtMs) || Date.now() - analyzedAtMs > ANALYSIS_CACHE_MS) return null;

  // JSON 列读回来是 unknown，逐条过 schema；坏一条就当缓存不可用，宁可重算
  const hypotheses: HypothesisDraft[] = [];
  for (const item of row.hypotheses) {
    const parsed = AnalysisResultSchema.shape.hypotheses.element.safeParse(item);
    if (!parsed.success) return null;
    hypotheses.push(parsed.data);
  }

  return {
    incidentId: row.id,
    code: row.code,
    source: meta.source,
    model: meta.model,
    cached: true,
    summary: row.summary,
    impactScope: row.impactScope,
    hypotheses,
    missingInfo: meta.missingInfo,
    tokensUsed: meta.tokensUsed ?? null,
    topologyLevel: meta.topology?.level ?? 'FULL',
    verify: meta.verify,
    trim: meta.trim,
    degradedReason: meta.degradedReason,
    analyzedAt: meta.analyzedAt,
  };
}

export async function runAnalysis(
  idOrCode: string,
  opts: { force?: boolean; tenantId?: string } = {},
): Promise<AnalysisOutcome | null> {
  const tenantId = opts.tenantId ?? 'default';
  if (!opts.force) {
    const cached = await readCachedAnalysis(idOrCode, tenantId);
    if (cached) return cached;
  }

  // 进度按调用方传入的标识做 key：前端用的是事件 id，直接命中；
  // 脚本传编码时查询侧会先解析再取（见 analyze/status 路由）。
  const progressKey = idOrCode;
  beginAnalysis(progressKey);

  try {
    enterStage(progressKey, 'CONTEXT');
    const ctx = await buildIncidentContext(idOrCode, tenantId);
    if (!ctx) {
      failAnalysis(progressKey, '事件不存在');
      return null;
    }

    enterStage(progressKey, 'REASONING');
    const mode = llmMode();
    const produced = await produceResult(ctx, mode);

    enterStage(progressKey, 'VERIFY');
    const verify = verifyHypotheses(produced.result.hypotheses, buildVerifyContext(ctx));

    // 后置门禁 GATE-02（Spec §3.3）：校验器只回答"证据真不真、相不相关"，
    // 门禁回答"这条推理有没有承重墙"—— 只引了拓扑/指标/案例的假设一律清空。
    // RCA_GATE=off 时连函数都不调用，行为逐字回到 0.1（验收标准 9）。
    const gate = rcaGateEnabled()
      ? gateHypotheses({ hypotheses: verify.kept, ctx })
      : { kept: verify.kept, cleared: [] };

    const analyzedAt = new Date().toISOString();
    // 缺拓扑时一律压低置信度（评审 P0-4）：上限由完整度决定，不是模型自己说了算。
    // 只做 min 截断，不改变假设之间的相对顺序。
    const kept = gate.kept.map((hypothesis) => ({
      ...hypothesis,
      confidence: capConfidence(hypothesis.confidence, ctx.topology.level),
    }));
    const missingInfo =
      kept.length === 0
        ? [
            ...new Set([
              ...produced.result.missingInfo,
              '全部假设未通过证据校验或归因门禁，未能给出可信根因',
              ...clearanceMissingInfo(gate.cleared),
            ]),
          ].slice(0, 5)
        : produced.result.missingInfo;
    const gateMeta = {
      cleared: gate.cleared.length,
      reasons: gate.cleared.map((item) => `${item.reason}：${item.detail}`),
    };

    const meta: AnalysisMeta = {
      analyzedAt,
      source: produced.source,
      model: produced.model,
      promptVersion: PROMPT_VERSION,
      missingInfo,
      verify: { dropped: verify.dropped, stats: verify.stats },
      trim: ctx.trim.trimmed,
      degradedReason: produced.degradedReason,
      tokensUsed: produced.tokensUsed,
      gate: gateMeta,
      promptHint: rcaHintEnabled() ? 'on' : 'off',
      topology: {
        level: ctx.topology.level,
        deviceCount: ctx.topology.deviceCount,
        linkedDevices: ctx.topology.linkedDevices,
        isolatedDevices: ctx.topology.isolatedDevices.length,
        components: ctx.topology.components,
        maxHops: ctx.topology.maxHops,
      },
    };

    enterStage(progressKey, 'PERSIST');
    await persistAnalysis({
      incidentId: ctx.incident.id,
      hypotheses: kept,
      summary: kept.length > 0 ? produced.result.summary : null,
      impactScope: kept.length > 0 ? produced.result.impactScope : null,
      source: produced.source,
      model: produced.model,
      tokensUsed: produced.tokensUsed,
      meta,
    });

    const progress = finishAnalysis(progressKey);

    log.info('rca_analyzed', {
      incident: ctx.incident.code,
      mode,
      source: produced.source,
      kept: kept.length,
      dropped: verify.dropped.length,
      chars: ctx.trim.chars,
    });

    return {
      incidentId: ctx.incident.id,
      code: ctx.incident.code,
      source: produced.source,
      model: produced.model,
      cached: false,
      summary: kept.length > 0 ? produced.result.summary : null,
      impactScope: kept.length > 0 ? produced.result.impactScope : null,
      hypotheses: kept,
      missingInfo,
      tokensUsed: produced.tokensUsed,
      topologyLevel: ctx.topology.level,
      verify: { dropped: verify.dropped, stats: verify.stats },
      trim: ctx.trim.trimmed,
      degradedReason: produced.degradedReason,
      analyzedAt,
      progress,
      gate: gateMeta,
    };
  } catch (error) {
    failAnalysis(progressKey, error instanceof Error ? error.message : String(error));
    throw error;
  }
}

/** 供健康检查/设置页展示，不触发任何调用 */
export function analysisMode(): { mode: LlmMode } {
  return { mode: llmMode() };
}
