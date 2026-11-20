import { describe, expect, it } from 'vitest';
import { AppError } from '@/lib/errors';
import { readJsonLimited, readTextLimited } from './body';

/**
 * 请求体流式限制（评审第 1 阶段）。
 *
 * 重点不是"正常 JSON 能读出来"，而是两条边界：
 * 1. 声明超限 → 一个字节都不读就打回；
 * 2. **没有 Content-Length 的 chunked 流** → 边读边计数，超限立刻断流。
 *    第 2 条是 Content-Length 检查完全防不住的场景，也是这里存在的理由。
 */

const encoder = new TextEncoder();

function post(body: BodyInit | null, headers: Record<string, string> = {}) {
  return new Request('http://localhost/api/v1/test', { method: 'POST', body, headers });
}

/** 构造 chunked 请求：没有 content-length，body 是一段一段来的 */
function chunkedRequest(chunks: readonly string[]): Request {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Request('http://localhost/api/v1/test', {
    method: 'POST',
    body: stream,
    // undici 要求流式 body 显式声明 half duplex，类型里没有这个字段
    duplex: 'half',
  } as unknown as RequestInit);
}

describe('readTextLimited', () => {
  it('正常读取文本', async () => {
    await expect(readTextLimited(post('hello'))).resolves.toBe('hello');
  });

  it('空 body 返回空串，不抛错', async () => {
    await expect(readTextLimited(post(null))).resolves.toBe('');
  });

  it('声明长度超限时直接 413', async () => {
    const req = post('{"a":1}');
    await expect(readTextLimited(req, 4)).rejects.toMatchObject({
      code: 'PAYLOAD_TOO_LARGE',
      status: 413,
    });
  });

  it('无 Content-Length 的流式请求超限时 413（chunked 防不住的那条路）', async () => {
    const req = chunkedRequest(['x'.repeat(64), 'y'.repeat(64)]);
    expect(req.headers.get('content-length')).toBeNull();

    const error = await readTextLimited(req, 100).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: 'PAYLOAD_TOO_LARGE', status: 413 });
  });

  it('多字节字符跨 chunk 也能正确解码', async () => {
    const text = '光模块光衰告警';
    const bytes = encoder.encode(text);
    // 故意从中间切开：单字节解码会在多字节字符上出乱码
    const cut = 4;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, cut));
        controller.enqueue(bytes.slice(cut));
        controller.close();
      },
    });
    const req = new Request('http://localhost/api/v1/test', {
      method: 'POST',
      body: stream,
      duplex: 'half',
    } as unknown as RequestInit);

    await expect(readTextLimited(req, 1024)).resolves.toBe(text);
  });
});

describe('readJsonLimited', () => {
  it('解析合法 JSON', async () => {
    await expect(readJsonLimited(post('{"scenario":"x","reset":true}'))).resolves.toEqual({
      scenario: 'x',
      reset: true,
    });
  });

  it('空 body 返回 null，让调用方用 ?? {} 兜底', async () => {
    await expect(readJsonLimited(post(null))).resolves.toBeNull();
  });

  it('非法 JSON 是 400 而不是 500', async () => {
    await expect(readJsonLimited(post('{oops'))).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      status: 400,
    });
  });

  it('超限优先于 JSON 解析：不把超大体积读进内存再报格式错', async () => {
    await expect(readJsonLimited(post(`{"a":"${'x'.repeat(200)}"}`), 50)).rejects.toMatchObject({
      code: 'PAYLOAD_TOO_LARGE',
    });
  });
});
