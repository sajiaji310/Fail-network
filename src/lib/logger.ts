import { env } from './env';

type LogPayload = Record<string, unknown>;

const LEVEL_WEIGHT: Record<string, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

const MIN_WEIGHT = LEVEL_WEIGHT[env.LOG_LEVEL] ?? 30;

/**
 * 结构化日志。字段固定：{ ts, level, module, action, durationMs?, ...ctx }
 * 禁止 console.log（ESLint 已拦截，见 13.2）
 */
function emit(level: keyof typeof LEVEL_WEIGHT, module: string, action: string, ctx?: LogPayload) {
  if (LEVEL_WEIGHT[level]! < MIN_WEIGHT) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, module, action, ...ctx });
  if (level === 'error' || level === 'fatal') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

export function createLogger(module: string) {
  return {
    info: (action: string, ctx?: LogPayload) => emit('info', module, action, ctx),
    warn: (action: string, ctx?: LogPayload) => emit('warn', module, action, ctx),
    error: (action: string, ctx?: LogPayload) => emit('error', module, action, ctx),
    debug: (action: string, ctx?: LogPayload) => emit('debug', module, action, ctx),
    /** 记录一次耗时操作，自动带 durationMs */
    timed: async <T>(action: string, fn: () => Promise<T>, ctx?: LogPayload): Promise<T> => {
      const start = Date.now();
      try {
        const result = await fn();
        emit('info', module, action, { ...ctx, durationMs: Date.now() - start, ok: true });
        return result;
      } catch (error) {
        emit('error', module, action, {
          ...ctx,
          durationMs: Date.now() - start,
          ok: false,
          err: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
  };
}

export type Logger = ReturnType<typeof createLogger>;
