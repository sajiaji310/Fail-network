import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { POST } from './route';

/**
 * 控制台登录路由：口令换 cookie 是 production 下唯一的人用入口，
 * 所以它必须和其他写路由一样过流式 body 限制（chunked 没有 Content-Length）。
 */
const URL = 'http://127.0.0.1:3000/api/console/session';
const ORIGINAL = process.env.CONSOLE_PASSWORD;

function jsonRequest(body: string): Request {
  return new Request(URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
}

/** 只关心 headers 的场景用最小 stub，避免 undici 改写 content-length */
function declaredLengthRequest(declared: number): Request {
  return {
    url: URL,
    headers: new Headers({ 'content-length': String(declared) }),
    body: null,
  } as Request;
}

describe('POST /api/console/session', () => {
  beforeEach(() => {
    process.env.CONSOLE_PASSWORD = 'secret';
  });
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.CONSOLE_PASSWORD;
    else process.env.CONSOLE_PASSWORD = ORIGINAL;
  });

  test('口令正确 → 200 + HttpOnly cookie', async () => {
    const res = await POST(jsonRequest(JSON.stringify({ password: 'secret' })));
    expect(res.status).toBe(200);
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('netscope_console=');
    expect(cookie.toLowerCase()).toContain('httponly');
    expect(cookie.toLowerCase()).toContain('samesite=lax');
  });

  test('口令错误 → 401 UNAUTHORIZED', async () => {
    const res = await POST(jsonRequest(JSON.stringify({ password: 'wrong' })));
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('UNAUTHORIZED');
  });

  test('未配置 CONSOLE_PASSWORD → 500 SERVER_MISCONFIG（fail-closed）', async () => {
    delete process.env.CONSOLE_PASSWORD;
    const res = await POST(jsonRequest(JSON.stringify({ password: 'secret' })));
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe('SERVER_MISCONFIG');
  });

  test('非法 JSON → 400；空 body → 400', async () => {
    const bad = await POST(jsonRequest('not-json'));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.code).toBe('VALIDATION_FAILED');

    const empty = await POST(jsonRequest(''));
    expect(empty.status).toBe(400);
  });

  test('声明的 Content-Length 超限 → 413 PAYLOAD_TOO_LARGE（与流式超限同一个 code）', async () => {
    const res = await POST(declaredLengthRequest(4 * 1024 * 1024));
    expect(res.status).toBe(413);
    expect((await res.json()).error.code).toBe('PAYLOAD_TOO_LARGE');
  });
});
