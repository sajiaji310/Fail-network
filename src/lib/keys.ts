/**
 * API Key → 角色 / 租户 的解析。
 *
 * 单 Key 时代（第 1 阶段）只有"对不对"一个问题；有了 RBAC 和租户之后，
 * 每个 Key 还要回答"能做什么、看到谁的数据"。因此配置升级成：
 *
 *   API_KEYS='[{"key":"sk-ops-xxx","role":"RESPONDER","tenant":"default","name":"值班-陈昊"}]'
 *
 * 兼容策略：`API_KEYS` 为空时退回单个 `API_KEY`，视为 ADMIN + default 租户。
 * 这条兼容不是偷懒 —— 已有部署和 E2E 都只配了 API_KEY，升级不该强制改配置。
 *
 * 这个文件刻意不 import 任何 node/prisma 模块：middleware 跑在 edge runtime，
 * 只能引用纯函数。
 */

export type Role = 'VIEWER' | 'RESPONDER' | 'ADMIN';

export const ROLE_RANK: Record<Role, number> = { VIEWER: 1, RESPONDER: 2, ADMIN: 3 };

export const DEFAULT_TENANT = 'default';

export type Credential = {
  key: string;
  role: Role;
  tenantId: string;
  /** 人话名字，进审计日志的 actor（`api-key:值班-陈昊` 比尾号好认） */
  name: string;
};

function isRole(value: unknown): value is Role {
  return value === 'VIEWER' || value === 'RESPONDER' || value === 'ADMIN';
}

/**
 * 解析配置。非法条目直接跳过而不是整体抛错：
 * 一个写错的 Key 不该让整站 500 —— 但会少一把能用的钥匙，配置错误要能从 401 里看出来。
 */
export function parseCredentials(apiKeysJson: string, singleKey: string): Credential[] {
  const raw = apiKeysJson.trim();
  if (raw.length > 0) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const list: Credential[] = [];
        for (const item of parsed) {
          if (!item || typeof item !== 'object') continue;
          const row = item as Record<string, unknown>;
          if (typeof row.key !== 'string' || row.key.trim().length === 0) continue;
          list.push({
            key: row.key,
            role: isRole(row.role) ? row.role : 'VIEWER',
            tenantId:
              typeof row.tenant === 'string' && row.tenant.trim().length > 0
                ? row.tenant.trim()
                : DEFAULT_TENANT,
            name: typeof row.name === 'string' && row.name.trim().length > 0 ? row.name : 'api-key',
          });
        }
        if (list.length > 0) return list;
      }
    } catch {
      // 落到单 Key 分支：配置写坏了至少让老 Key 还能用
    }
  }

  const key = singleKey.trim();
  if (key.length === 0) return [];
  return [{ key, role: 'ADMIN', tenantId: DEFAULT_TENANT, name: 'api-key' }];
}

/** 常量时间比较，避免按字符提前返回泄漏前缀 */
export function keyMatches(given: string, expected: string): boolean {
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

export function findCredential(
  credentials: readonly Credential[],
  key: string | null,
): Credential | null {
  if (!key) return null;
  for (const credential of credentials) {
    if (keyMatches(key, credential.key)) return credential;
  }
  return null;
}

/** 对外展示用：脱敏到只剩尾 4 位 */
export function maskKey(key: string): string {
  return key.length < 12 ? '***' : `…${key.slice(-4)}`;
}
