import { env } from '@/lib/env';
import { AppError } from '@/lib/errors';

/**
 * 请求体读取（评审第 1 阶段「请求体流式限制」）。
 *
 * 为什么不能只信 Content-Length：
 * 1. `Transfer-Encoding: chunked` 根本不带这个头，声明检查直接失效；
 * 2. 声明值可以撒谎（写 10 字节、实际灌 1GB），等 `req.json()` 读完内存已经爆了。
 *
 * 所以这里真的把流读一遍，读到超限立刻 `cancel()` 断开上游，再抛 413。
 * 语义上仍然先看 Content-Length 是为了"明显超限时一个字节都不读"，
 * 但安全性由边读边计数保证。
 */

function tooLarge(limit: number): AppError {
  return new AppError(
    'PAYLOAD_TOO_LARGE',
    `请求体超过 ${Math.round(limit / 1024)}KB 限制，请分批提交`,
    { limitBytes: limit },
  );
}

function declaredTooLarge(req: Request, limit: number): boolean {
  const raw = req.headers.get('content-length');
  if (!raw) return false;
  const declared = Number(raw);
  return Number.isFinite(declared) && declared > limit;
}

export async function readTextLimited(
  req: Request,
  limit: number = env.BODY_LIMIT_BYTES,
): Promise<string> {
  if (declaredTooLarge(req, limit)) throw tooLarge(limit);
  if (!req.body) return '';

  const reader = req.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let received = 0;
  let text = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > limit) {
        // 先断开，别让客户端继续往一个已经注定失败的请求里灌数据
        await reader.cancel().catch(() => undefined);
        throw tooLarge(limit);
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // cancel 之后锁已释放，这里再释放会抛 TypeError，忽略即可
    }
  }

  return text + decoder.decode();
}

/**
 * 读 JSON body。空 body 返回 null 而不是抛错 —— 调用方普遍用
 * `?.field` 取值，把它们从 `req.json().catch(() => null)` 里解放出来。
 */
export async function readJsonLimited(
  req: Request,
  limit: number = env.BODY_LIMIT_BYTES,
): Promise<unknown> {
  const text = (await readTextLimited(req, limit)).trim();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new AppError('VALIDATION_FAILED', '请求体不是合法 JSON');
  }
}
