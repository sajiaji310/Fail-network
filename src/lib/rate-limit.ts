import { findCredential, type Credential } from './keys';

/**
 * 限流身份。
 *
 * 带了合法 API Key 的请求按钥匙计数，不看 IP：调用方伪造 `x-forwarded-for`
 * 也换不了桶。没有钥匙时，只有显式声明信任反向代理，才读取代理注入的地址；
 * 否则所有匿名请求共用 `ip:unknown`，限额更紧，但伪造不了新桶。
 */
export function rateLimitIdentity(input: {
  apiKey: string | null;
  forwardedFor: string | null;
  realIp: string | null;
  credentials: readonly Credential[];
  trustProxy: boolean;
}): string {
  const credential = findCredential(input.credentials, input.apiKey);
  if (credential) return `key:${credential.tenantId}:${credential.name}`;

  if (input.trustProxy) {
    const forwarded = input.forwardedFor?.split(',')[0]?.trim();
    if (forwarded) return `ip:${forwarded}`;
    const real = input.realIp?.trim();
    if (real) return `ip:${real}`;
  }

  return 'ip:unknown';
}
