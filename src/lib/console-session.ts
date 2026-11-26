/**
 * 控制台登录票据。
 *
 * production 下页面不走 API Key（浏览器不会自己带 x-api-key），
 * 用一个口令换 HttpOnly cookie。校验放在 middleware，所以这里只用 Web Crypto，
 * 不引用 node:crypto，edge 和 Node 都能跑。
 */

export const CONSOLE_COOKIE = 'netscope_console';
export const CONSOLE_TTL_MS = 12 * 60 * 60 * 1000;
export const CONSOLE_TTL_SECONDS = CONSOLE_TTL_MS / 1000;

const PURPOSE = 'netscope-console-v1';

function bytesToHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return bytesToHex(sig);
}

export function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function signConsoleSession(password: string, now = Date.now()): Promise<string> {
  const exp = now + CONSOLE_TTL_MS;
  const sig = await hmacHex(password, `${PURPOSE}.${exp}`);
  return `${exp}.${sig}`;
}

export async function verifyConsoleSession(
  token: string,
  password: string,
  now = Date.now(),
): Promise<boolean> {
  if (!password || !token) return false;
  const dot = token.indexOf('.');
  if (dot <= 0) return false;
  const expRaw = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || exp <= now) return false;
  if (exp > now + CONSOLE_TTL_MS + 60_000) return false;
  const expected = await hmacHex(password, `${PURPOSE}.${expRaw}`);
  return timingSafeEqualStr(expected, sig);
}

/** 先哈希再比较，避免口令长度从比较耗时里漏出去。空口令永远不通过。 */
export async function passwordsMatch(input: string, expected: string): Promise<boolean> {
  if (!expected || !input) return false;
  const digest = async (value: string) => {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return bytesToHex(bytes);
  };
  const [left, right] = await Promise.all([digest(input), digest(expected)]);
  return timingSafeEqualStr(left, right);
}

/**
 * 登录成功后只跳回站内路径。
 * `//host`、反斜杠和带协议的地址都按站外处理，回到概览。
 */
export function safeNextPath(raw: string | null | undefined): string {
  if (!raw) return '/overview';
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return '/overview';
  if (raw.includes('\\') || raw.includes('://')) return '/overview';
  const path = raw.split('?')[0] ?? '';
  if (path === '/login' || path.startsWith('/login/')) return '/overview';
  return raw;
}
