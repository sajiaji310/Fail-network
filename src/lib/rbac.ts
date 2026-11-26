import type { Role } from './keys';
import { ROLE_RANK } from './keys';

/**
 * 角色与权限判定（评审第 4 阶段「RBAC」）。
 *
 * 三条原则：
 * 1. **默认拒绝写，读保持公开**：写操作一律要 RESPONDER 以上。
 *    读接口本身仍不要求 API Key。production 的控制台页面另走口令 cookie（见 middleware）。
 * 2. **敏感读单独提级**：审计、数据源密钥、保留策略这类"能反推谁动了什么"的接口给 ADMIN。
 * 3. **路径判定而不是路由内判定**：把规则集中在纯函数里，路由改了路径规则也会跟着失效，
 *    比在 20 个 route.ts 里各写一遍 `if (role !== 'ADMIN')` 更不容易漏。
 */

export const ROLE_LABEL: Record<Role, string> = {
  VIEWER: '只读',
  RESPONDER: '处置',
  ADMIN: '管理员',
};

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** 需要 ADMIN 才能访问的路径前缀（读也算） */
const ADMIN_PATHS = ['/api/v1/audit', '/api/v1/admin', '/api/v1/sources'];

export function requiredRole(method: string, pathname: string): Role | null {
  const upper = method.toUpperCase();
  if (ADMIN_PATHS.some((prefix) => pathname.startsWith(prefix))) return 'ADMIN';
  if (WRITE_METHODS.has(upper)) return 'RESPONDER';
  return null;
}

export function hasRole(actual: Role, required: Role | null): boolean {
  if (required === null) return true;
  return ROLE_RANK[actual] >= ROLE_RANK[required];
}
