import { describe, expect, it } from 'vitest';
import { findCredential, keyMatches, maskKey, parseCredentials } from './keys';
import { hasRole, requiredRole } from './rbac';

describe('API Key 配置解析', () => {
  it('API_KEYS 里的角色与租户按条目生效', () => {
    const list = parseCredentials(
      JSON.stringify([
        { key: 'sk-viewer-0001', role: 'VIEWER', tenant: 'acme', name: '只读' },
        { key: 'sk-ops-00000002', role: 'RESPONDER' },
        { key: 'sk-admin-000003', role: 'ADMIN', tenant: 'acme' },
      ]),
      '',
    );
    expect(list).toHaveLength(3);
    expect(list[0]).toMatchObject({ role: 'VIEWER', tenantId: 'acme', name: '只读' });
    // 没写 role/tenant 时落到最保守的默认值
    expect(list[1]).toMatchObject({ role: 'RESPONDER', tenantId: 'default', name: 'api-key' });
  });

  it('只配置 API_KEY 时视为 ADMIN + default，兼容旧部署', () => {
    const list = parseCredentials('', 'sk-legacy-key-123456');
    expect(list).toEqual([
      { key: 'sk-legacy-key-123456', role: 'ADMIN', tenantId: 'default', name: 'api-key' },
    ]);
  });

  it('配置写坏不让整站 500，退回单 Key', () => {
    const list = parseCredentials('{not json', 'sk-legacy-123456');
    expect(list).toHaveLength(1);
    expect(list[0]!.role).toBe('ADMIN');
  });

  it('非法 role 降级成 VIEWER，缺 key 的条目被跳过', () => {
    const list = parseCredentials(
      JSON.stringify([{ key: 'k1', role: 'SUPERUSER' }, { role: 'ADMIN' }, null, 'x']),
      '',
    );
    expect(list).toHaveLength(1);
    expect(list[0]!.role).toBe('VIEWER');
  });

  it('全空配置得到空列表（production 会因此 500 fail-closed）', () => {
    expect(parseCredentials('', '')).toEqual([]);
  });

  it('按 Key 精确匹配，长度不同不匹配', () => {
    const list = parseCredentials('', 'sk-abcdef123456');
    expect(findCredential(list, 'sk-abcdef123456')?.role).toBe('ADMIN');
    expect(findCredential(list, 'sk-abcdef12345')).toBeNull();
    expect(findCredential(list, '')).toBeNull();
    expect(findCredential(list, null)).toBeNull();
  });

  it('keyMatches 只在完全相同时为真（长度不同立刻 false）', () => {
    expect(keyMatches('abc', 'abc')).toBe(true);
    expect(keyMatches('abc', 'abd')).toBe(false);
    expect(keyMatches('abc', 'abcd')).toBe(false);
  });

  it('脱敏只留尾 4 位，短 key 全遮', () => {
    expect(maskKey('sk-1234567890abcdef')).toBe('…cdef');
    expect(maskKey('short')).toBe('***');
  });
});

describe('RBAC 路径规则', () => {
  it('读接口不需要角色，写接口需要 RESPONDER', () => {
    expect(requiredRole('GET', '/api/v1/incidents')).toBeNull();
    expect(requiredRole('POST', '/api/v1/incidents/abc/analyze')).toBe('RESPONDER');
    expect(requiredRole('DELETE', '/api/v1/incidents/abc/claim')).toBe('RESPONDER');
    expect(requiredRole('POST', '/api/v1/ingest/alertmanager')).toBe('RESPONDER');
  });

  it('审计、数据源、管理接口连读都要 ADMIN', () => {
    expect(requiredRole('GET', '/api/v1/audit')).toBe('ADMIN');
    expect(requiredRole('POST', '/api/v1/admin/retention')).toBe('ADMIN');
    expect(requiredRole('GET', '/api/v1/sources/aliases')).toBe('ADMIN');
  });

  it('角色按等级比较：ADMIN 可做 RESPONDER 的事，反之不行', () => {
    expect(hasRole('ADMIN', 'RESPONDER')).toBe(true);
    expect(hasRole('RESPONDER', 'ADMIN')).toBe(false);
    expect(hasRole('VIEWER', 'RESPONDER')).toBe(false);
    expect(hasRole('VIEWER', null)).toBe(true);
  });
});
