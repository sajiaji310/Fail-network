import { describe, expect, it } from 'vitest';
import type { Credential } from './keys';
import { rateLimitIdentity } from './rate-limit';

const KEYS: Credential[] = [
  { key: 'sk-tenant-a-1234', role: 'RESPONDER', tenantId: 'acme', name: '值班' },
];

describe('rateLimitIdentity', () => {
  it('合法 API Key 按租户和钥匙名分桶，忽略伪造的转发头', () => {
    expect(
      rateLimitIdentity({
        apiKey: 'sk-tenant-a-1234',
        forwardedFor: '1.1.1.1',
        realIp: null,
        credentials: KEYS,
        trustProxy: false,
      }),
    ).toBe('key:acme:值班');
  });

  it('未声明信任代理时，不采用客户端传来的地址', () => {
    expect(
      rateLimitIdentity({
        apiKey: null,
        forwardedFor: '8.8.8.8, 10.0.0.1',
        realIp: '9.9.9.9',
        credentials: KEYS,
        trustProxy: false,
      }),
    ).toBe('ip:unknown');
  });

  it('信任代理时取 x-forwarded-for 的第一跳', () => {
    expect(
      rateLimitIdentity({
        apiKey: null,
        forwardedFor: '203.0.113.8, 10.0.0.1',
        realIp: '10.0.0.1',
        credentials: [],
        trustProxy: true,
      }),
    ).toBe('ip:203.0.113.8');
  });
});
