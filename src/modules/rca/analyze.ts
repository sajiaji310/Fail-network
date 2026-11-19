import { db } from '@/lib/db';
import { llmMode, type LlmMode } from '@/lib/env';
import { completeJson, extractJson } from '@/lib/llm/client';
import { createLogger } from '@/lib/logger';
import { buildIncidentContext, type ContextBundle } from './context';
import { ruleFallback } from './fallback';
import { buildMockModelOutput } from './mock';
import { persistAnalysis } from './persist';
import { PROMPT_VERSION, renderPrompt } from './prompt';
import {
  AnalysisResultSchema,
  parseAnalysisMeta,
  type AnalysisMeta,
  type AnalysisResult,
  type Drop,
  type HypothesisDraft,
} from './schema';
import { buildVerifyContext, verifyHypotheses } from './verify';

/**
 * 研判编排（文档 4.1 步 4~6 + 10.4 调用策略）。
 *
 *   context → (规则 fallback | LLM) → zod 校验（失败修复一次）→ L1/L2/L3 → 落库
 *
 * 三条不能让步的约束：
 *   1. 无 key 全链路可用（AC-07）：fallback 不是"出错时的兜底"，而是一等公民；
 *   2. 模型输出不合 schema 就修复一次，再不合就降级，绝不把半成品塞给前端；
 *   3. 校验后若一条不剩，落空摘要 + missingInfo（AC-20），不留上一轮结论。
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
  verify: {
    dropped: Drop[];
    stats: { rawEvidence: number; validEvidence: number; relevanceRate: number };
  };
  trim: string[];
  degradedReason: string | null;
  analyzedAt: string;
};

type ParsedResult = { ok: true; data: AnalysisResult } | { ok: false; error: string };

function parseResult(content: string): ParsedResult {
  const raw = extractJson(content);
  if (raw === null) return { ok: false, error: '输出不是合法 JSON' };
  const parsed = AnalysisResultSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    return { ok: false, error: detail };
  }
  return { ok: true, data: parsed.data };
}

/** 从库里读回上一次研判（命中缓存时不再调用模型） */
async function readCachedAnalysis(idOrCode: string): Promise<AnalysisOutcome | null> {
  const row = await db.incident.findFirst({
    where: { OR: [{ id: idOrCode }, { code: idOrCode }] },
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
    verify: meta.verify,
    trim: meta.trim,
    degradedReason: meta.degradedReason,
    analyzedAt: meta.analyzedAt,
  };
}

function degradedOutcome(ctx: ContextBundle, reason: string) {
  const result = ruleFallback(ctx);
  return {
    result,
    source: 'RULE_FALLBACK' as const,
    model: null,
    tokensUsed: null,
    degradedReason: reason,
  };
}

async function produceResult(
  ctx: ContextBundle,
  mode: LlmMode,
): Promise<{
  result: AnalysisResult;
  source: 'LLM' | 'RULE_FALLBACK';
  model: string | null;
  tokensUsed: number | null;
  degradedReason: string | null;
}> {
  if (mode === 'fallback') {
    return degradedOutcome(ctx, '未配置 LLM_API_KEY，本次由规则引擎给出结论');
  }

  const prompt = renderPrompt(ctx);
  const fixture = () => buildMockModelOutput(ctx);

  try {
    const first = await completeJson({ ...prompt, mock: fixture });
    const parsed = parseResult(first.content);
    if (parsed.ok) {
      return {
        result: parsed.data,
        source: 'LLM',
        model: first.model,
        tokensUsed: first.tokensUsed,
        degradedReason: null,
      };
    }

    // 修复重试（文档 10.4）：把 zod 错误原样回喂，只重试一次
    log.warn('rca_schema_retry', { error: parsed.error });
    const repair = await completeJson({
      ...prompt,
      user: `${prompt.user}\n\n[上一次输出未通过校验]\n${parsed.error}\n请修正后只输出 JSON 对象。`,
      mock: fixture,
    });
    const repaired = parseResult(repair.content);
    if (repaired.ok) {
      return {
        result: repaired.data,
        source: 'LLM',
        model: repair.model,
        tokensUsed: (first.tokensUsed ?? 0) + (repair.tokensUsed ?? 0),
        degradedReason: '首次输出格式不合格，已修复一次',
      };
    }

    return degradedOutcome(ctx, `模型输出两次未通过 schema 校验：${repaired.error.slice(0, 120)}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return degradedOutcome(ctx, `模型调用失败（${message.slice(0, 120)}）`);
  }
}

export async function runAnalysis(
  idOrCode: string,
  opts: { force?: boolean } = {},
): Promise<AnalysisOutcome | null> {
  if (!opts.force) {
    const cached = await readCachedAnalysis(idOrCode);
    if (cached) return cached;
  }

  const ctx = await buildIncidentContext(idOrCode);
  if (!ctx) return null;

  const mode = llmMode();
  const produced = await produceResult(ctx, mode);
  const verify = verifyHypotheses(produced.result.hypotheses, buildVerifyContext(ctx));

  const analyzedAt = new Date().toISOString();
  const kept = verify.kept;
  const missingInfo =
    kept.length === 0
      ? [...new Set([...produced.result.missingInfo, '全部假设未通过证据校验，未能给出可信根因'])]
      : produced.result.missingInfo;

  const meta: AnalysisMeta = {
    analyzedAt,
    source: produced.source,
    model: produced.model,
    promptVersion: PROMPT_VERSION,
    missingInfo,
    verify: { dropped: verify.dropped, stats: verify.stats },
    trim: ctx.trim.trimmed,
    degradedReason: produced.degradedReason,
  };

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
    verify: { dropped: verify.dropped, stats: verify.stats },
    trim: ctx.trim.trimmed,
    degradedReason: produced.degradedReason,
    analyzedAt,
  };
}

/** 供健康检查/设置页展示，不触发任何调用 */
export function analysisMode(): { mode: LlmMode } {
  return { mode: llmMode() };
}
