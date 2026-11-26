import { rcaGateEnabled, type LlmMode } from '@/lib/env';
import {
  completeJson,
  extractJson,
  LLM_TIMEOUT_FIRST_MS,
  LLM_TIMEOUT_REPAIR_MS,
} from '@/lib/llm/client';
import { createLogger } from '@/lib/logger';
import type { ContextBundle } from './context';
import { ruleFallback } from './fallback';
import { R1_REASON, shouldAbstainBeforeModel } from './gate';
import { buildMockModelOutput } from './mock';
import { renderPrompt } from './prompt';
import { AnalysisResultSchema, type AnalysisResult } from './schema';

/**
 * "把一次研判结论产出出来"这一段：规则兜底 / 前置门禁 / 模型调用 / 校验修复 / 止损。
 * 从 `analyze.ts` 拆出来是为了让编排层只做编排（取数 → 产出 → 校验 → 落库），
 * 也让"什么时候不调模型"这条判断只有一处。
 *
 * 三条不能让步的约束：
 *   1. 无 key 全链路可用（AC-07）：规则引擎不是"出错时的兜底"，而是一等公民；
 *   2. 模型输出不合 schema 就修复一次，再不合就降级，绝不把半成品塞给前端；
 *   3. 被 max_tokens 截断不修复重试 —— 半截 JSON 再问一次大概率还是半截，只是多花 8 秒。
 */

const log = createLogger('rca');

export type ProduceOutcome = {
  result: AnalysisResult;
  source: 'LLM' | 'RULE_FALLBACK';
  model: string | null;
  tokensUsed: number | null;
  degradedReason: string | null;
  /**
   * 本次是"门禁拒答"，不是"模型失败降级"。
   * 两者 source 都是 RULE_FALLBACK，但延迟口径必须分开：拒答根本没调模型，
   * 混进延迟统计就是拿"没跑"当"跑得快"（Spec §4 要求剔除）。
   */
  abstained: boolean;
  /** 命中的拒答规则编号（PRD AC-2 要求规则编号可落库）；未命中为 null */
  abstainRule: 'R1' | null;
};

type ParsedResult = { ok: true; data: AnalysisResult } | { ok: false; error: string };

export function parseResult(content: string): ParsedResult {
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

/** 降级出口：规则引擎跑一遍，token 一律记 null（没调模型就没有成本） */
export function degradedOutcome(
  ctx: ContextBundle,
  reason: string,
  abstainRule: 'R1' | null = null,
): ProduceOutcome {
  return {
    result: ruleFallback(ctx),
    source: 'RULE_FALLBACK',
    model: null,
    tokensUsed: null,
    degradedReason: reason,
    abstained: abstainRule !== null,
    abstainRule,
  };
}

export async function produceResult(ctx: ContextBundle, mode: LlmMode): Promise<ProduceOutcome> {
  if (mode === 'fallback') {
    return degradedOutcome(ctx, '未配置 LLM_API_KEY，本次由规则引擎给出结论');
  }

  // 前置门禁 R1：这次事件里没有任何"可归因"的东西，模型只会编一个像样的答案出来。
  // 放在这里而不是 route 层，是为了让"没调用模型"这件事也走同一条降级路径（source / tokensUsed 一致）。
  if (rcaGateEnabled()) {
    const decision = shouldAbstainBeforeModel(ctx);
    if (decision.abstain) return degradedOutcome(ctx, decision.reason ?? R1_REASON, 'R1');
  }

  const prompt = renderPrompt(ctx);
  const fixture = () => buildMockModelOutput(ctx);

  try {
    const first = await completeJson({ ...prompt, mock: fixture, timeoutMs: LLM_TIMEOUT_FIRST_MS });
    const parsed = parseResult(first.content);
    if (parsed.ok) {
      return {
        result: parsed.data,
        source: 'LLM',
        model: first.model,
        tokensUsed: first.tokensUsed,
        degradedReason: null,
        abstained: false,
        abstainRule: null,
      };
    }

    // 止损一：撞上 max_tokens。此时内容必然被砍断，修复重试等于拿 8 秒赌同一件事
    if (first.finishReason === 'length') {
      return degradedOutcome(ctx, '模型输出被 max_tokens 截断，未重试，直接由规则引擎给出结论');
    }

    // 止损二：首调已经吃掉整个预算。再修复一次必然把总耗时推到 20s 以上
    if (first.latencyMs > LLM_TIMEOUT_FIRST_MS) {
      return degradedOutcome(
        ctx,
        `首次模型调用耗时 ${first.latencyMs}ms，超出预算，未重试，直接由规则引擎给出结论`,
      );
    }

    // 修复重试（文档 10.4）：把 zod 错误原样回喂，只重试一次
    log.warn('rca_schema_retry', { error: parsed.error });
    const repair = await completeJson({
      ...prompt,
      user: `${prompt.user}\n\n[上一次输出未通过校验]\n${parsed.error}\n请修正后只输出 JSON 对象。`,
      mock: fixture,
      timeoutMs: LLM_TIMEOUT_REPAIR_MS,
    });
    const repaired = parseResult(repair.content);
    if (repaired.ok) {
      return {
        result: repaired.data,
        source: 'LLM',
        model: repair.model,
        tokensUsed: (first.tokensUsed ?? 0) + (repair.tokensUsed ?? 0),
        degradedReason: '首次输出格式不合格，已修复一次',
        abstained: false,
        abstainRule: null,
      };
    }

    return degradedOutcome(ctx, `模型输出两次未通过 schema 校验：${repaired.error.slice(0, 120)}`);
  } catch (error) {
    // 超时与网络错误都在这里：只有一次调用机会，失败即降级，不再叠加第二次等待
    const message = error instanceof Error ? error.message : String(error);
    return degradedOutcome(ctx, `模型调用失败（${message.slice(0, 120)}）`);
  }
}
