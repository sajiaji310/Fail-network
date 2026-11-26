import { z } from 'zod';

/**
 * 环境变量唯一读取入口。禁止在业务代码里直接 process.env.*
 * 只在服务端可用（LLM key 不允许 NEXT_PUBLIC_ 前缀，见 13.3）
 */
const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL 未配置，检查 .env'),
  LLM_BASE_URL: z.string().min(1).default('https://api.deepseek.com/v1'),
  LLM_API_KEY: z.string().default(''),
  LLM_MODEL_FAST: z.string().default('deepseek-chat'),
  LLM_MODEL_REASON: z.string().default('deepseek-chat'),
  LLM_MOCK: z.enum(['true', 'false']).default('false'),
  APP_BASE_URL: z.string().default('http://localhost:3000'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  SIM_DEFAULT_SEED: z.string().default('42'),
  PG_HOME: z.string().optional(),
  PGDATA: z.string().optional(),
  PGPORT: z.string().default('5432'),
  // —— 安全边界（P0）：local 放行，production 才强制鉴权 ——
  APP_ENV: z.enum(['local', 'staging', 'production']).default('local'),
  API_KEY: z.string().default(''),
  /** production 下控制台页面的口令。local 不校验。空字符串表示未配置。 */
  CONSOLE_PASSWORD: z.string().default(''),
  RATE_LIMIT_WRITE_PER_MIN: z.coerce.number().int().min(1).default(30),
  RATE_LIMIT_READ_PER_MIN: z.coerce.number().int().min(1).default(120),
  BODY_LIMIT_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .default(2 * 1024 * 1024),
  // —— 研判质量开关（Spec 0.2）：全部 on/off 二值，写错立刻在启动时炸，不做静默兜底 ——
  /** 归因字典注入（§3.2）。off = 回滚到 rca-1.0 的提示词形态 */
  RCA_HINT: z.enum(['on', 'off']).default('on'),
  /** 设备信号段（§3.1/§4.5）。只用于 B 组消融，不得在 test 集上打开 */
  RCA_SIGNALS: z.enum(['on', 'off']).default('off'),
  /** 两段式拒答门禁（§3.3）。off = 两条门禁都不生效，行为回到 0.1 */
  RCA_GATE: z.enum(['on', 'off']).default('on'),
  /** 空结论规则补位（§3.4）。off = 模型没给出可用结论时就给空结论 */
  RCA_RESCUE: z.enum(['on', 'off']).default('on'),
});

export type AppEnv = z.infer<typeof EnvSchema>;

function loadEnv(): AppEnv {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`环境变量校验失败 → ${detail}`);
  }
  return parsed.data;
}

export const env = loadEnv();

/** LLM 运行模式：mock（固定 fixture）/ live（真实调用）/ fallback（无 key，走规则引擎） */
export type LlmMode = 'mock' | 'live' | 'fallback';

export function llmMode(): LlmMode {
  if (env.LLM_MOCK === 'true') return 'mock';
  if (env.LLM_API_KEY.trim().length === 0) return 'fallback';
  return 'live';
}

/**
 * 研判质量开关的读取口（Spec 0.2）。
 *
 * 一律走函数而不是直接在业务代码里比字符串：开关是**回滚手段**，
 * 读它的地方越少，回滚时才越敢相信"关了就真的回到 0.1"。
 */
export function rcaHintEnabled(): boolean {
  return env.RCA_HINT === 'on';
}

export function rcaSignalsEnabled(): boolean {
  return env.RCA_SIGNALS === 'on';
}

export function rcaGateEnabled(): boolean {
  return env.RCA_GATE === 'on';
}

export function rcaRescueEnabled(): boolean {
  return env.RCA_RESCUE === 'on';
}
