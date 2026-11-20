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
  RATE_LIMIT_WRITE_PER_MIN: z.coerce.number().int().min(1).default(30),
  RATE_LIMIT_READ_PER_MIN: z.coerce.number().int().min(1).default(120),
  BODY_LIMIT_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .default(2 * 1024 * 1024),
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
