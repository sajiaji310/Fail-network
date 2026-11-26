import { NextResponse, type NextRequest } from 'next/server';
import { CONSOLE_COOKIE, safeNextPath, verifyConsoleSession } from '@/lib/console-session';
import { findCredential, parseCredentials } from '@/lib/keys';
import { rateLimitIdentity } from '@/lib/rate-limit';
import { hasRole, requiredRole, ROLE_LABEL } from '@/lib/rbac';

/**
 * 安全边界中间件（P0 + 第 1 阶段 + 第 4 阶段 RBAC + 控制台登录）。
 *
 * - 鉴权：仅 production 环境生效，覆盖两类请求：
 *   1. `/api/v1/*` 的写方法（POST/PATCH/PUT/DELETE）→ 需要 RESPONDER 以上；
 *   2. 审计 / 数据源 / 管理接口（读也算）→ 需要 ADMIN。
 *   local/staging 放行 —— 保证 E2E、评测脚本、本地开发不被破坏。
 * - 控制台：production 下页面要 CONSOLE_PASSWORD 换的 cookie。没配口令则页面 500，
 *   不把未登录的控制台放出去。`/login` 和 `/api/*` 不走这道门。
 * - 角色：Key 上带 role（见 `lib/keys.ts` 的 API_KEYS 格式），不足返回 403 并说明需要什么角色。
 * - 限流：仍只打在原来的 API 上，另加登录接口，避免口令被撞。页面浏览不计入这个窗口。
 * - 请求体大小：这里只按 Content-Length 做"明显超限直接打回"，
 *   chunked 上传由 `lib/http/body.ts` 边读边计数拦截。
 */
const APP_ENV = process.env.APP_ENV ?? 'local';
const CONSOLE_PASSWORD = process.env.CONSOLE_PASSWORD ?? '';
const CREDENTIALS = parseCredentials(process.env.API_KEYS ?? '', process.env.API_KEY ?? '');
const WRITE_LIMIT = Number(process.env.RATE_LIMIT_WRITE_PER_MIN ?? 30);
const READ_LIMIT = Number(process.env.RATE_LIMIT_READ_PER_MIN ?? 120);
const BODY_LIMIT = Number(process.env.BODY_LIMIT_BYTES ?? 2 * 1024 * 1024);

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const WINDOW_MS = 60_000;
const TRUST_PROXY = process.env.TRUST_PROXY_HEADERS === 'true';

type Bucket = { w: number[]; r: number[] };
const buckets = new Map<string, Bucket>();

function pruneBuckets(now: number): void {
  if (buckets.size < 200) return;
  for (const [key, bucket] of buckets) {
    bucket.w = bucket.w.filter((ts) => now - ts <= WINDOW_MS);
    bucket.r = bucket.r.filter((ts) => now - ts <= WINDOW_MS);
    if (bucket.w.length === 0 && bucket.r.length === 0) buckets.delete(key);
  }
}

function tooMany(key: string, write: boolean): boolean {
  const now = Date.now();
  pruneBuckets(now);
  const bucket = buckets.get(key) ?? { w: [], r: [] };
  if (!buckets.has(key)) buckets.set(key, bucket);
  const arr = write ? bucket.w : bucket.r;
  while (arr.length > 0 && now - arr[0]! > WINDOW_MS) arr.shift();
  if (arr.length >= (write ? WRITE_LIMIT : READ_LIMIT)) return true;
  arr.push(now);
  return false;
}

function clientKey(req: NextRequest): string {
  return rateLimitIdentity({
    apiKey: req.headers.get('x-api-key'),
    forwardedFor: req.headers.get('x-forwarded-for'),
    realIp: req.headers.get('x-real-ip'),
    credentials: CREDENTIALS,
    trustProxy: TRUST_PROXY,
  });
}

function reject(code: string, message: string, status: number, extra?: Record<string, unknown>) {
  return NextResponse.json({ error: { code, message, ...extra } }, { status });
}

function isGuardedApi(pathname: string): boolean {
  return (
    pathname.startsWith('/api/v1/') ||
    pathname === '/api/health' ||
    pathname === '/api/live' ||
    pathname === '/api/ready' ||
    pathname.startsWith('/api/console/')
  );
}

function isLoginPath(pathname: string): boolean {
  return pathname === '/login' || pathname.startsWith('/login/');
}

function isConsolePage(pathname: string): boolean {
  if (pathname.startsWith('/api/') || pathname.startsWith('/_next/')) return false;
  if (isLoginPath(pathname)) return false;
  const leaf = pathname.split('/').pop() ?? '';
  if (leaf.includes('.')) return false;
  return true;
}

function readSession(req: NextRequest): string | null {
  const direct = req.cookies?.get?.(CONSOLE_COOKIE)?.value;
  if (direct) return direct;
  const raw = req.headers.get('cookie');
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === CONSOLE_COOKIE) return decodeURIComponent(rest.join('='));
  }
  return null;
}

async function hasValidSession(req: NextRequest): Promise<boolean> {
  const token = readSession(req);
  if (!token || !CONSOLE_PASSWORD) return false;
  return verifyConsoleSession(token, CONSOLE_PASSWORD);
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const isWrite = WRITE_METHODS.has(req.method);

  if (isWrite && isGuardedApi(pathname)) {
    const cl = Number(req.headers.get('content-length') ?? '0');
    if (cl > BODY_LIMIT) {
      return reject('BODY_TOO_LARGE', `请求体超过 ${BODY_LIMIT} 字节限制`, 413);
    }
  }

  const required = pathname.startsWith('/api/v1/') ? requiredRole(req.method, pathname) : null;

  if (APP_ENV === 'production' && required !== null) {
    if (CREDENTIALS.length === 0) {
      return reject('SERVER_MISCONFIG', 'production 环境未配置 API_KEY / API_KEYS', 500);
    }
    const credential = findCredential(CREDENTIALS, req.headers.get('x-api-key'));
    if (!credential) {
      return reject('UNAUTHORIZED', '缺少或错误的 x-api-key', 401);
    }
    if (!hasRole(credential.role, required)) {
      return reject(
        'FORBIDDEN',
        `需要 ${ROLE_LABEL[required]}（${required}）权限，当前 Key 为 ${ROLE_LABEL[credential.role]}`,
        403,
        { required, actual: credential.role },
      );
    }
  }

  if (isGuardedApi(pathname) && tooMany(clientKey(req), isWrite)) {
    return reject('RATE_LIMITED', '请求过于频繁，请稍后再试', 429, { retryAfter: 60 });
  }

  if (isLoginPath(pathname)) {
    if (APP_ENV === 'production' && CONSOLE_PASSWORD && (await hasValidSession(req))) {
      const next = safeNextPath(req.nextUrl.searchParams?.get('next'));
      return NextResponse.redirect(new URL(next, req.url));
    }
    return NextResponse.next();
  }

  if (isConsolePage(pathname) && APP_ENV === 'production') {
    if (!CONSOLE_PASSWORD) {
      return new NextResponse('production 环境未配置 CONSOLE_PASSWORD', {
        status: 500,
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'x-error-code': 'SERVER_MISCONFIG',
        },
      });
    }
    if (!(await hasValidSession(req))) {
      const login = new URL('/login', req.url);
      const next = `${pathname}${req.nextUrl.search ?? ''}`;
      login.searchParams.set('next', next);
      return NextResponse.redirect(login);
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    '/api/v1/:path*',
    '/api/health',
    '/api/live',
    '/api/ready',
    '/api/console/:path*',
    '/((?!api|_next/static|_next/image|favicon.ico|icon.svg).*)',
  ],
};
