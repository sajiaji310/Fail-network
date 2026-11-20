import { NextResponse, type NextRequest } from 'next/server';

/**
 * 安全边界中间件（P0）。
 *
 * - API Key：仅 production 环境、且 /api/v1/* 的写方法（POST/PATCH/PUT/DELETE）需要
 *   `x-api-key`。local/staging 放行 —— 保证 E2E、评测脚本、本地开发不被破坏。
 * - 限流：全环境、按 IP 的内存滑动窗口。写接口更严（默认 30/min），读接口宽松（120/min）。
 *   单实例 MVP 够用；多实例需换成 Redis 计数器。
 * - 请求体大小：写请求按 Content-Length 兜底；chunked 流式限制由各 handler 自行实现。
 *
 * 读接口（GET 查询、页面浏览）不要求 API Key —— MVP 单用户场景下，
 * 全站 Basic Auth 会破坏浏览器体验，留给反向代理/Docker 网络层处理。
 */
const APP_ENV = process.env.APP_ENV ?? 'local';
const API_KEY = process.env.API_KEY ?? '';
const WRITE_LIMIT = Number(process.env.RATE_LIMIT_WRITE_PER_MIN ?? 30);
const READ_LIMIT = Number(process.env.RATE_LIMIT_READ_PER_MIN ?? 120);
const BODY_LIMIT = Number(process.env.BODY_LIMIT_BYTES ?? 2 * 1024 * 1024);

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const WINDOW_MS = 60_000;

type Bucket = { w: number[]; r: number[] };
const buckets = new Map<string, Bucket>();

function tooMany(ip: string, write: boolean): boolean {
  const now = Date.now();
  const b = buckets.get(ip) ?? { w: [], r: [] };
  if (!buckets.has(ip)) buckets.set(ip, b);
  const arr = write ? b.w : b.r;
  while (arr.length > 0 && now - arr[0]! > WINDOW_MS) arr.shift();
  if (arr.length >= (write ? WRITE_LIMIT : READ_LIMIT)) return true;
  arr.push(now);
  return false;
}

function clientIp(req: NextRequest): string {
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0]!.trim();
  return 'unknown';
}

function reject(code: string, message: string, status: number, extra?: Record<string, unknown>) {
  return NextResponse.json({ error: { code, message, ...extra } }, { status });
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const isWrite = WRITE_METHODS.has(req.method);

  // 请求体大小兜底（chunked 在 handler 层再 guard）
  if (isWrite) {
    const cl = Number(req.headers.get('content-length') ?? '0');
    if (cl > BODY_LIMIT) {
      return reject('BODY_TOO_LARGE', `请求体超过 ${BODY_LIMIT} 字节限制`, 413);
    }
  }

  // API Key：production + 写接口
  if (APP_ENV === 'production' && isWrite && pathname.startsWith('/api/v1/')) {
    if (!API_KEY) {
      return reject('SERVER_MISCONFIG', 'production 环境未配置 API_KEY', 500);
    }
    const key = req.headers.get('x-api-key');
    if (key !== API_KEY) {
      return reject('UNAUTHORIZED', '缺少或错误的 x-api-key', 401);
    }
  }

  // 限流（health/live/ready 也算读，避免被刷爆）
  if (tooMany(clientIp(req), isWrite)) {
    return reject('RATE_LIMITED', '请求过于频繁，请稍后再试', 429, { retryAfter: 60 });
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/api/v1/:path*', '/api/health', '/api/live', '/api/ready'],
};
