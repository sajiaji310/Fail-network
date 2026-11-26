import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeContext } from './test-utils';
import { ruleFallback } from './fallback';
import type { ContextBundle } from './context';

/**
 * 产出段单测（Spec §3.3 R1 + §3.5 修复止损）。
 *
 * 这里不打真实模型：把 `completeJson` 换成可编程的桩，用来回答两个问题——
 *   "该不调模型的时候，是不是真的一次都没调？"（省的不是钱，是值班人等的 7 秒）
 *   "被截断 / 首调超预算的时候，是不是真的没再重试？"（否则止损就是一句注释）
 */

const store = vi.hoisted(() => ({
  calls: [] as { user: string; timeoutMs?: number; maxTokens?: number }[],
  responses: [] as unknown[],
  error: null as Error | null,
}));

vi.mock('@/lib/llm/client', () => ({
  LLM_TIMEOUT_MS: 30_000,
  LLM_TIMEOUT_FIRST_MS: 12_000,
  LLM_TIMEOUT_REPAIR_MS: 8_000,
  LLM_MAX_TOKENS: 2400,
  extractJson: (content: string): unknown => {
    try {
      return JSON.parse(content);
    } catch {
      return null;
    }
  },
  completeJson: async (req: { user: string; timeoutMs?: number; maxTokens?: number }) => {
    store.calls.push(req);
    if (store.error) throw store.error;
    const next = store.responses.shift();
    if (!next) throw new Error('测试桩没有准备返回值');
    return next;
  },
}));

const { produceResult } = await import('./produce');

const ctx = makeContext();
const VALID = JSON.stringify(ruleFallback(ctx));

function response(over: Partial<Record<string, unknown>> = {}) {
  return {
    content: VALID,
    model: 'stub-model',
    tokensUsed: 1200,
    mode: 'live',
    latencyMs: 3000,
    finishReason: 'stop',
    completionTokens: 800,
    ...over,
  };
}

/** 全部告警类型未登记、无事件前变更 = R1 命中形态 */
const r1Ctx: ContextBundle = {
  ...ctx,
  alerts: ctx.alerts.map((a, i) => ({
    ...a,
    id: `u-${i}`,
    type: `UNKNOWN_${i}`,
    alertClass: 'UNKNOWN' as const,
  })),
  changes: ctx.changes.filter((c) => !c.beforeFirstAlert),
};

beforeEach(() => {
  store.calls.length = 0;
  store.responses.length = 0;
  store.error = null;
});

describe('前置 R1：命中就不调模型', () => {
  it('R1 命中时 source=RULE_FALLBACK、tokensUsed=null、一次调用都没发', async () => {
    const outcome = await produceResult(r1Ctx, 'live');
    expect(store.calls).toHaveLength(0);
    expect(outcome.source).toBe('RULE_FALLBACK');
    expect(outcome.tokensUsed).toBeNull();
    expect(outcome.degradedReason).toContain('闸门 R1');
  });

  it('R1 命中时仍给出规则引擎的结论结构（包括空结论也原样返回，不编造）', async () => {
    const outcome = await produceResult(r1Ctx, 'live');
    expect(outcome.result).toEqual(ruleFallback(r1Ctx));
  });

  it('有已登记告警时正常调模型', async () => {
    store.responses.push(response());
    const outcome = await produceResult(ctx, 'live');
    expect(store.calls).toHaveLength(1);
    expect(store.calls[0]?.timeoutMs).toBe(12_000);
    expect(outcome.source).toBe('LLM');
    expect(outcome.tokensUsed).toBe(1200);
  });
});

describe('修复止损（§3.5）', () => {
  it('被 max_tokens 截断 → 不修复重试，直接降级', async () => {
    store.responses.push(response({ content: '{"summary":"被砍断', finishReason: 'length' }));
    const outcome = await produceResult(ctx, 'live');
    expect(store.calls).toHaveLength(1);
    expect(outcome.source).toBe('RULE_FALLBACK');
    expect(outcome.degradedReason).toContain('截断');
  });

  it('首调耗时超预算 → 不修复重试，直接降级', async () => {
    store.responses.push(response({ content: 'not json', latencyMs: 13_500 }));
    const outcome = await produceResult(ctx, 'live');
    expect(store.calls).toHaveLength(1);
    expect(outcome.degradedReason).toContain('超出预算');
  });

  it('普通 schema 不合格 → 修复一次，且修复用 8s 预算', async () => {
    store.responses.push(response({ content: 'not json', tokensUsed: 500 }));
    store.responses.push(response({ tokensUsed: 700 }));
    const outcome = await produceResult(ctx, 'live');
    expect(store.calls).toHaveLength(2);
    expect(store.calls[1]?.timeoutMs).toBe(8_000);
    expect(outcome.source).toBe('LLM');
    expect(outcome.tokensUsed).toBe(1200);
    expect(outcome.degradedReason).toContain('已修复一次');
  });

  it('修复也失败 → 降级，不再有第三次调用', async () => {
    store.responses.push(response({ content: 'not json' }));
    store.responses.push(response({ content: 'still not json' }));
    const outcome = await produceResult(ctx, 'live');
    expect(store.calls).toHaveLength(2);
    expect(outcome.source).toBe('RULE_FALLBACK');
    expect(outcome.degradedReason).toContain('两次未通过 schema 校验');
  });

  it('超时 / 网络错误 → 直接降级，不重试', async () => {
    store.error = new Error('Request timed out.');
    const outcome = await produceResult(ctx, 'live');
    expect(store.calls).toHaveLength(1);
    expect(outcome.source).toBe('RULE_FALLBACK');
    expect(outcome.degradedReason).toContain('模型调用失败');
  });
});

describe('无 key 路径', () => {
  it('mode=fallback 时直接走规则引擎并说明原因', async () => {
    const outcome = await produceResult(ctx, 'fallback');
    expect(store.calls).toHaveLength(0);
    expect(outcome.source).toBe('RULE_FALLBACK');
    expect(outcome.degradedReason).toContain('LLM_API_KEY');
  });
});
