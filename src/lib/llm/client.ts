import OpenAI from 'openai';
import { env, llmMode, type LlmMode } from '@/lib/env';
import { createLogger } from '@/lib/logger';

/**
 * LLM 调用出口（OpenAI 兼容协议：DeepSeek / 通义 / OpenAI 通用）。
 *
 * 三态由 env 决定，业务层不关心：
 *   fallback  无 key → 调用方直接走规则引擎，本文件不会被触达
 *   mock      LLM_MOCK=true → 用调用方提供的 fixture，零网络零费用
 *   live      真实调用，单次超时由调用方按"首调 / 修复"分别给定，失败抛 LlmError 由调用方降级
 *
 * 为什么 mock 的 fixture 由调用方注入而不是写死在这：fixture 必须引用**本次事件真实存在的
 * alertId/changeId**，否则证据校验器会把整条假设丢弃，mock 链路就"通不了"。所以假输出
 * 只能由知道上下文的一侧生成，这里只负责"假装是一次模型返回"。
 */

/** 兜底上限：调用方没指定 timeoutMs 时用它，正常路径不该走到这里 */
export const LLM_TIMEOUT_MS = 30_000;
/** 首调预算：实测 P95 14991ms 里含一次 7 秒的无效等待，12s 足够正常返回 */
export const LLM_TIMEOUT_FIRST_MS = 12_000;
/** 修复预算：修复只是把 JSON 补全，给 8s 已经是宽裕 */
export const LLM_TIMEOUT_REPAIR_MS = 8_000;
/**
 * 输出上限（Spec §3.5）。2400 是"3 条假设 × 收窄后的字段"的实测余量：
 * 截断率 ≥5% 才上调到 3000，<2% 才下调到 1800 —— 不靠感觉调。
 */
export const LLM_MAX_TOKENS = 2400;

const log = createLogger('llm');

export class LlmError extends Error {
  readonly detail?: unknown;

  constructor(message: string, detail?: unknown) {
    super(message);
    this.name = 'LlmError';
    this.detail = detail;
  }
}

export type LlmRequest = {
  system: string;
  user: string;
  model?: string;
  /** 本次调用的输出上限，缺省 LLM_MAX_TOKENS */
  maxTokens?: number;
  /** 本次调用的超时，缺省 LLM_TIMEOUT_MS（调用方应按首调/修复分别传） */
  timeoutMs?: number;
  /** mock 模式下返回的假 JSON。缺省则 mock 直接失败（等于让调用方降级） */
  mock?: () => string;
};

export type LlmResponse = {
  content: string;
  model: string;
  tokensUsed: number | null;
  mode: LlmMode;
  /** 真实调用的耗时，mock/fallback 为 0 */
  latencyMs: number;
  /** 'length' = 撞上 max_tokens 被截断：调用方不得重试，直接降级 */
  finishReason: string | null;
  completionTokens: number | null;
};

export type LlmStatus = {
  mode: LlmMode;
  model: string;
  baseUrl: string;
};

export function llmStatus(): LlmStatus {
  return { mode: llmMode(), model: env.LLM_MODEL_REASON, baseUrl: env.LLM_BASE_URL };
}

let cached: OpenAI | null = null;

function client(): OpenAI {
  if (!cached) {
    cached = new OpenAI({
      apiKey: env.LLM_API_KEY,
      baseURL: env.LLM_BASE_URL,
      timeout: LLM_TIMEOUT_MS, // 实例级上限；单次预算由 per-request options 覆盖
      maxRetries: 0, // 重试由 analyze 层按"修复一次"的语义控制，避免叠加放大延迟
    });
  }
  return cached;
}

export async function completeJson(req: LlmRequest): Promise<LlmResponse> {
  const mode = llmMode();
  const model = req.model ?? env.LLM_MODEL_REASON;

  if (mode === 'mock') {
    if (!req.mock) {
      throw new LlmError('mock 模式缺少 fixture 生成器');
    }
    return {
      content: req.mock(),
      model: 'mock',
      tokensUsed: 0,
      mode,
      latencyMs: 0,
      finishReason: 'stop',
      completionTokens: 0,
    };
  }

  if (mode === 'fallback') {
    throw new LlmError('未配置 LLM_API_KEY，不应进入模型调用');
  }

  const startedAt = Date.now();
  try {
    const res = await client().chat.completions.create(
      {
        model,
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.user },
        ],
        // JSON 模式：DeepSeek 与 OpenAI 都支持，仍要用 zod 再校验一次（模型会漏字段）
        response_format: { type: 'json_object' },
        temperature: 0.2,
        max_tokens: req.maxTokens ?? LLM_MAX_TOKENS,
      },
      // per-request 超时：SDK 的 timeout 参数按请求覆盖实例默认值，
      // 这样"首调 12s / 修复 8s"不必建两个 client
      { timeout: req.timeoutMs ?? LLM_TIMEOUT_MS },
    );

    const choice = res.choices[0];
    const content = choice?.message?.content;
    if (!content) {
      throw new LlmError('模型返回空内容');
    }

    const finishReason: string | null = choice?.finish_reason ?? null;
    const completionTokens = res.usage?.completion_tokens ?? null;
    if (finishReason === 'length') {
      // 截断是可观测的质量事故：输出被砍断后 JSON 必然不完整，
      // 与其修复重试再赌一次，不如让调用方直接降级（Spec §3.5）
      log.warn('llm_truncated', {
        model: res.model || model,
        maxTokens: req.maxTokens ?? LLM_MAX_TOKENS,
        completionTokens,
        latencyMs: Date.now() - startedAt,
      });
    }

    return {
      content,
      model: res.model || model,
      tokensUsed: res.usage?.total_tokens ?? null,
      mode,
      latencyMs: Date.now() - startedAt,
      finishReason,
      completionTokens,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn('llm_call_failed', { err: message, model, latencyMs: Date.now() - startedAt });
    throw error instanceof LlmError ? error : new LlmError(message, error);
  }
}

/** 从模型输出里抠出 JSON：有的模型会包一层 ```json 围栏，json_object 模式下偶发 */
export function extractJson(content: string): unknown {
  const trimmed = content.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const body = fenced?.[1]?.trim() ?? trimmed;
  try {
    return JSON.parse(body);
  } catch {
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(body.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}
