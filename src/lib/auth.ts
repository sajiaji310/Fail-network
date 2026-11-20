import { AppError } from './errors';
import {
  DEFAULT_TENANT,
  findCredential,
  maskKey,
  parseCredentials,
  type Credential,
  type Role,
} from './keys';
import { hasRole, requiredRole } from './rbac';

/**
 * 请求身份解析（服务端）。
 *
 * 与 middleware 分工：
 * - middleware 负责"能不能进来"（有没有 Key、角色够不够），失败直接 401/403；
 * - 这里负责"以什么身份处理"（actor、tenant），供审计与数据隔离使用。
 *
 * 本文件只在 Node runtime 引用（route.ts / RSC），不进 middleware ——
 * middleware 在 edge 跑，走 `lib/keys` + `lib/rbac` 两个纯函数模块。
 */

const APP_ENV = process.env.APP_ENV ?? 'local';
const CREDENTIALS: Credential[] = parseCredentials(
  process.env.API_KEYS ?? '',
  process.env.API_KEY ?? '',
);

export function credentialOf(req: Request): Credential | null {
  return findCredential(CREDENTIALS, req.headers.get('x-api-key'));
}

/**
 * 当前请求的租户。
 *
 * local/staging 没有 Key 概念，统一 default；production 下 middleware 已经保证
 * 写请求带了合法 Key，这里取 Key 上绑定的租户。
 *
 * **不接受 `x-tenant` 之类的请求头**：租户如果由调用方自称，隔离就只是一句口号。
 */
export function tenantOf(req: Request): string {
  if (APP_ENV !== 'production') return DEFAULT_TENANT;
  return credentialOf(req)?.tenantId ?? DEFAULT_TENANT;
}

export function roleOf(req: Request): Role {
  if (APP_ENV !== 'production') return 'ADMIN';
  return credentialOf(req)?.role ?? 'VIEWER';
}

/**
 * 路由内二次校验（纵深防御）：middleware 的 matcher 是 `/api/v1/:path*`，
 * 将来若调整 matcher 或有人直接在同进程调用 handler，这里是最后一道。
 */
export function assertRole(req: Request, method: string, pathname: string): void {
  if (APP_ENV !== 'production') return;
  const required = requiredRole(method, pathname);
  const actual = roleOf(req);
  if (!hasRole(actual, required)) {
    throw new AppError('FORBIDDEN', `需要 ${required} 角色，当前为 ${actual}`, {
      required,
      actual,
    });
  }
}

/** 审计 actor：production 用 Key 的名字（没有则脱敏尾号），本地记 local */
export function actorOf(req: Request): string {
  const credential = credentialOf(req);
  if (!credential) return 'local';
  const label = credential.name !== 'api-key' ? credential.name : maskKey(credential.key);
  return `api-key:${label}`;
}
