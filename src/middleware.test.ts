import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import { signConsoleSession } from '@/lib/console-session';

/**
 * 安全边界中间件单测（P0）。
 * 用 resetModules + stubEnv 隔离模块级常量（APP_ENV/API_KEY 在 import 时求值）。
 * middleware 只用到 nextUrl.pathname / method / headers 三处，构造最小 mock 即可，
 * 不依赖 NextRequest 在 node 测试环境的真实构造行为。
 */
function mkReq(
  pathname: string,
  method = 'GET',
  headers: Record<string, string> = {},
): NextRequest {
  const url = new URL(pathname, 'http://127.0.0.1:3000');
  return {
    url: url.toString(),
    nextUrl: url,
    method,
    headers: new Headers(headers),
  } as NextRequest;
}

async function loadMiddleware(overrides: Record<string, string> = {}) {
  vi.resetModules();
  for (const [k, v] of Object.entries(overrides)) vi.stubEnv(k, v);
  const mod = await import('@/middleware');
  return mod.middleware;
}

describe('middleware 安全边界', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test('local 模式：写接口不带 key 也放行（不破坏 E2E/评测）', async () => {
    const mw = await loadMiddleware({ APP_ENV: 'local' });
    const res = await mw(mkReq('/api/v1/incidents/x/analyze', 'POST'));
    expect(res.status).toBe(200);
  });

  test('production：写接口无 key → 401', async () => {
    const mw = await loadMiddleware({ APP_ENV: 'production', API_KEY: 'secret' });
    const res = await mw(mkReq('/api/v1/incidents/x/analyze', 'POST'));
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('UNAUTHORIZED');
  });

  test('production：写接口 key 错 → 401；key 对 → 放行', async () => {
    const mw = await loadMiddleware({ APP_ENV: 'production', API_KEY: 'secret' });
    const bad = await mw(mkReq('/api/v1/ingest/alerts', 'POST', { 'x-api-key': 'wrong' }));
    expect(bad.status).toBe(401);
    const good = await mw(mkReq('/api/v1/ingest/alerts', 'POST', { 'x-api-key': 'secret' }));
    expect(good.status).toBe(200);
  });

  test('production：读接口（GET）不需要 key', async () => {
    const mw = await loadMiddleware({ APP_ENV: 'production', API_KEY: 'secret' });
    const res = await mw(mkReq('/api/v1/incidents', 'GET'));
    expect(res.status).toBe(200);
  });

  test('production：API_KEY 未配置 + 写请求 → 500 SERVER_MISCONFIG（fail-closed）', async () => {
    const mw = await loadMiddleware({ APP_ENV: 'production', API_KEY: '' });
    const res = await mw(mkReq('/api/v1/ingest/simulate', 'POST'));
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe('SERVER_MISCONFIG');
  });

  test('请求体超限 → 413', async () => {
    const mw = await loadMiddleware({ APP_ENV: 'local', BODY_LIMIT_BYTES: '1024' });
    const res = await mw(mkReq('/api/v1/ingest/alerts', 'POST', { 'content-length': '2048' }));
    expect(res.status).toBe(413);
    expect((await res.json()).error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  test('限流：连续写超过配额 → 429', async () => {
    const mw = await loadMiddleware({
      APP_ENV: 'local',
      RATE_LIMIT_WRITE_PER_MIN: '3',
    });
    // 前 3 次放行
    for (let i = 0; i < 3; i++) {
      expect((await mw(mkReq('/api/v1/incidents/x/analyze', 'POST'))).status).toBe(200);
    }
    // 第 4 次 429
    const res = await mw(mkReq('/api/v1/incidents/x/analyze', 'POST'));
    expect(res.status).toBe(429);
    expect((await res.json()).error.code).toBe('RATE_LIMITED');
  });

  test('local：控制台页面不要求登录', async () => {
    const mw = await loadMiddleware({ APP_ENV: 'local' });
    const res = await mw(mkReq('/overview'));
    expect(res.status).toBe(200);
  });

  test('production：没配控制台口令 → 页面 500；登录页仍可打开', async () => {
    const mw = await loadMiddleware({
      APP_ENV: 'production',
      API_KEY: 'secret',
      CONSOLE_PASSWORD: '',
    });
    const page = await mw(mkReq('/overview'));
    expect(page.status).toBe(500);
    expect(page.headers.get('x-error-code')).toBe('SERVER_MISCONFIG');
    const login = await mw(mkReq('/login'));
    expect(login.status).toBe(200);
  });

  test('production：已登录的页面可以写接口，不另带 API Key', async () => {
    const mw = await loadMiddleware({
      APP_ENV: 'production',
      API_KEY: '',
      CONSOLE_PASSWORD: 'secret',
    });
    const forged = await mw(mkReq('/api/v1/incidents/x', 'PATCH', { 'x-netscope-console': '1' }));
    expect(forged.status).toBe(500);

    const token = await signConsoleSession('secret');
    const allowed = await mw(
      mkReq('/api/v1/incidents/x', 'PATCH', { cookie: `netscope_console=${token}` }),
    );
    expect(allowed.status).toBe(200);
  });

  test('production：无 cookie 跳到登录，带对的 cookie 放行', async () => {
    const mw = await loadMiddleware({
      APP_ENV: 'production',
      API_KEY: 'secret',
      CONSOLE_PASSWORD: 'secret',
    });
    const blocked = await mw(mkReq('/overview'));
    expect(blocked.status).toBe(307);
    expect(blocked.headers.get('location')).toContain('/login');
    expect(blocked.headers.get('location')).toContain('next=%2Foverview');

    const token = await signConsoleSession('secret');
    const allowed = await mw(mkReq('/overview', 'GET', { cookie: `netscope_console=${token}` }));
    expect(allowed.status).toBe(200);
  });
});
