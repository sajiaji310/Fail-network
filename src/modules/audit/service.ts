import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { createLogger } from '@/lib/logger';
import { AppError } from '@/lib/errors';
import { tenantOf } from '@/lib/auth';

/**
 * 操作审计（评审第 1 阶段「审计日志」）。
 *
 * 与结构化日志的分工：
 * - `logger` 面向排障，可以降级、可以丢，落 stdout 就算了；
 * - 审计面向追责与复盘，必须落库 —— "这条假设是谁采纳的""这个事件是谁结案的"
 *   事后只能从 AuditLog 回答，日志滚掉就没了。
 *
 * 三条硬约束：
 * 1. **写审计失败不阻断业务**。人已经把故障处理完了，不能因为一条审计写不进去
 *    就返回 500。失败退化成一条 warn 日志，宁可少一条记录也不毁主流程。
 * 2. **不记请求体**。只记路由显式声明的小体积字段（行数、剧本名、force 标记），
 *    否则 keys/token/告警原文会全量抄进审计表。
 * 3. **失败也记**。401/409/500 往往比成功更值得查，result=FAIL 时 detail 带错误码与
 *    一句话原因，但不带堆栈。
 */

const logger = createLogger('audit');

export const AUDIT_ACTIONS = [
  'analyze.run',
  'hypothesis.verdict',
  'incident.transition',
  'alert.ingest',
  'metric.ingest',
  'retention.run',
  'source.alias',
  'scenario.inject',
  'correlation.run',
  'correlation.replay',
  'report.generate',
  'case.verify',
  'incident.split',
  'incident.claim',
  'incident.release',
  'hypothesis.verify',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export type AuditResult = 'OK' | 'FAIL';

export type AuditItem = {
  id: string;
  at: string;
  action: string;
  actor: string;
  target: string | null;
  result: string;
  detail: Record<string, unknown> | null;
  requestId: string | null;
  ip: string | null;
};

export type AuditInput = {
  action: AuditAction;
  actor: string;
  target?: string | null;
  result?: AuditResult;
  detail?: Record<string, unknown> | null;
  requestId?: string | null;
  ip?: string | null;
  tenantId?: string;
};

/**
 * 操作者标识。
 *
 * 只留 API Key 尾 4 位：审计表会被导出、被贴进复盘文档，把整把钥匙抄进去
 * 等于把审计表变成了泄密点。local 环境没有 key，记 `local` 即可。
 */
export function resolveActor(req: Request): string {
  const key = req.headers.get('x-api-key')?.trim() ?? '';
  if (!key) return 'local';
  return key.length >= 12 ? `api-key:…${key.slice(-4)}` : 'api-key';
}

export function resolveIp(
  req: Request,
  trustProxy = process.env.TRUST_PROXY_HEADERS === 'true',
): string | null {
  if (!trustProxy) return null;
  const forwarded = req.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]!.trim() || null;
  return req.headers.get('x-real-ip')?.trim() || null;
}

/** 落一条审计。永不抛异常 —— 调用方不需要 try/catch 包它 */
export async function recordAudit(input: AuditInput): Promise<void> {
  try {
    await db.auditLog.create({
      data: {
        action: input.action,
        actor: input.actor,
        target: input.target ?? null,
        result: input.result ?? 'OK',
        detail: (input.detail ?? null) as Prisma.InputJsonValue,
        requestId: input.requestId ?? null,
        ip: input.ip ?? null,
        tenantId: input.tenantId ?? 'default',
      },
    });
  } catch (error) {
    logger.warn('audit_write_failed', {
      action: input.action,
      target: input.target ?? null,
      err: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * 路由级包装：包住一次写操作，成功记 OK、失败记 FAIL 后原样抛出。
 *
 * 这样路由里只多一行 `audited(req, {...}, async () => { ... })`，
 * 不会出现"有的分支忘了记审计"——埋点跟着业务代码走，漏不掉。
 */
export async function audited<T>(
  req: Request,
  meta: {
    action: AuditAction;
    target?: string | null;
    detail?: Record<string, unknown>;
    /** 成功后才知道的字段（from→to、created/updated 数量），失败路径拿不到也不该编 */
    detailOf?: (result: T) => Record<string, unknown>;
    /** 路由生成的 traceId；审计与响应头用同一个，排障时能对上 */
    requestId?: string | null;
  },
  run: () => Promise<T>,
): Promise<T> {
  const actor = resolveActor(req);
  const ip = resolveIp(req);
  const requestId = meta.requestId ?? req.headers.get('x-request-id') ?? null;
  const tenantId = tenantOf(req);

  try {
    const result = await run();
    await recordAudit({
      action: meta.action,
      target: meta.target,
      actor,
      ip,
      requestId,
      tenantId,
      result: 'OK',
      detail: { ...meta.detail, ...meta.detailOf?.(result) },
    });
    return result;
  } catch (error) {
    await recordAudit({
      action: meta.action,
      target: meta.target,
      actor,
      ip,
      requestId,
      tenantId,
      result: 'FAIL',
      detail: {
        ...meta.detail,
        error:
          error instanceof AppError
            ? { code: error.code, message: error.message }
            : { code: 'INTERNAL', message: '未识别异常' },
      },
    });
    throw error;
  }
}

export type AuditQuery = {
  action?: string;
  result?: string;
  /** 操作者：`api-key:…cdef` / `local` / `system` */
  actor?: string;
  /** 时间窗（含边界） */
  from?: Date;
  to?: Date;
  /** 分页游标：上一页最后一条的 at */
  cursor?: Date;
  limit?: number;
  /** 租户过滤；不传表示不隔离（仅本地单租户页面使用） */
  tenantId?: string;
};

/**
 * 审计查询。
 *
 * 分页用 `at < cursor` 而不是 offset：审计是只追加的时间序列，
 * 翻页期间新记录进来会让 offset 分页重复或漏条 —— 按时间倒序翻就不存在这个问题。
 * cursor 取上一页最后一条的 `at`，同毫秒的极端情况下可能少一条，可接受。
 */
export async function listAudit(query: AuditQuery = {}): Promise<AuditItem[]> {
  const limit = Math.min(200, Math.max(1, query.limit ?? 30));
  const rows = await db.auditLog.findMany({
    where: {
      ...(query.action ? { action: query.action } : {}),
      ...(query.result ? { result: query.result } : {}),
      ...(query.actor ? { actor: { contains: query.actor } } : {}),
      ...(query.tenantId ? { tenantId: query.tenantId } : {}),
      ...(query.from || query.to
        ? {
            at: {
              ...(query.from ? { gte: query.from } : {}),
              ...(query.to ? { lte: query.to } : {}),
            },
          }
        : {}),
      ...(query.cursor ? { at: { lt: query.cursor } } : {}),
    },
    orderBy: { at: 'desc' },
    take: limit,
    select: {
      id: true,
      at: true,
      action: true,
      actor: true,
      target: true,
      result: true,
      detail: true,
      requestId: true,
      ip: true,
    },
  });

  return rows.map((row) => ({
    id: row.id,
    at: row.at.toISOString(),
    action: row.action,
    actor: row.actor,
    target: row.target,
    result: row.result,
    detail: (row.detail as Record<string, unknown> | null) ?? null,
    requestId: row.requestId,
    ip: row.ip,
  }));
}

export type AuditSummary = {
  total: number;
  last24h: number;
  failures: number;
  /** 各动作的 24h 计数，按次数降序；只给页面画个分布，不做图表库 */
  byAction: { action: string; count: number }[];
};

export async function getAuditSummary(tenantId?: string): Promise<AuditSummary> {
  const since = new Date(Date.now() - 24 * 3600_000);
  const scope = tenantId ? { tenantId } : {};
  try {
    const [total, last24h, failures, grouped] = await Promise.all([
      db.auditLog.count({ where: scope }),
      db.auditLog.count({ where: { ...scope, at: { gte: since } } }),
      db.auditLog.count({ where: { ...scope, at: { gte: since }, result: 'FAIL' } }),
      db.auditLog.groupBy({
        by: ['action'],
        where: { ...scope, at: { gte: since } },
        _count: { _all: true },
      }),
    ]);

    return {
      total,
      last24h,
      failures,
      byAction: grouped
        .map((g) => ({ action: g.action, count: g._count._all }))
        .sort((a, b) => b.count - a.count || a.action.localeCompare(b.action)),
    };
  } catch {
    // 库没起时设置页仍要能打开：降级成全 0，页面自己会提示
    return { total: 0, last24h: 0, failures: 0, byAction: [] };
  }
}
