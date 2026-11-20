/**
 * 统一错误类型与错误码（第 9 节错误码表）。
 * 业务层只抛 AppError，HTTP 映射集中在 toHttpError()。
 */
export const ERROR_CODES = {
  VALIDATION_FAILED: { status: 400, message: '参数校验失败' },
  UNAUTHORIZED: { status: 401, message: '缺少或错误的凭证' },
  FORBIDDEN: { status: 403, message: '当前角色无权执行该操作' },
  NOT_FOUND: { status: 404, message: '资源不存在' },
  INVALID_TRANSITION: { status: 409, message: '事件状态非法流转' },
  ALREADY_CLAIMED: { status: 409, message: '事件已被他人接手' },
  INCIDENT_CLOSED: { status: 409, message: '事件已结束，不能再变更处理人' },
  DUPLICATE_FINGERPRINT: { status: 409, message: '告警指纹冲突' },
  PAYLOAD_TOO_LARGE: { status: 413, message: '请求体过大' },
  RATE_LIMITED: { status: 429, message: '请求过于频繁' },
  LLM_UNAVAILABLE: { status: 503, message: '模型不可用且降级失败' },
  INTERNAL: { status: 500, message: '服务内部错误' },
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, message?: string, details?: unknown) {
    super(message ?? ERROR_CODES[code].message);
    this.name = 'AppError';
    this.code = code;
    this.status = ERROR_CODES[code].status;
    this.details = details;
  }
}

export type ErrorBody = {
  error: { code: ErrorCode; message: string; details?: unknown };
};

/** 任意异常 → 统一响应体（未识别的异常一律 INTERNAL，不泄漏堆栈） */
export function toErrorBody(error: unknown): { status: number; body: ErrorBody } {
  if (error instanceof AppError) {
    return {
      status: error.status,
      body: { error: { code: error.code, message: error.message, details: error.details } },
    };
  }
  return {
    status: ERROR_CODES.INTERNAL.status,
    body: { error: { code: 'INTERNAL', message: ERROR_CODES.INTERNAL.message } },
  };
}
