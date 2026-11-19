import type { IncidentStatus, Prisma, Severity } from '@prisma/client';
import { db } from '@/lib/db';

/** `GET /api/v1/incidents` 的查询实现（文档 11 节第 12 条） */

export type IncidentListQuery = {
  status?: IncidentStatus[];
  severity?: Severity[];
  from?: Date;
  to?: Date;
  page: number;
  pageSize: number;
};

export type IncidentListItem = {
  id: string;
  code: string;
  title: string;
  status: IncidentStatus;
  severity: Severity;
  summary: string | null;
  startedAt: Date;
  lastSeen: Date;
  resolvedAt: Date | null;
  mttrSeconds: number | null;
  alertCount: number;
  deviceCount: number;
  deviceNames: string[];
  reopenedCount: number;
  mergedIntoId: string | null;
};

export type IncidentListResult = {
  items: IncidentListItem[];
  total: number;
  page: number;
  pageSize: number;
};

export async function listIncidents(query: IncidentListQuery): Promise<IncidentListResult> {
  const where: Prisma.IncidentWhereInput = {
    ...(query.status?.length ? { status: { in: query.status } } : {}),
    ...(query.severity?.length ? { severity: { in: query.severity } } : {}),
    ...(query.from || query.to
      ? {
          startedAt: {
            ...(query.from ? { gte: query.from } : {}),
            ...(query.to ? { lte: query.to } : {}),
          },
        }
      : {}),
  };

  const [total, rows] = await Promise.all([
    db.incident.count({ where }),
    db.incident.findMany({
      where,
      // 活跃事件优先，其次按开始时间倒序
      orderBy: [{ status: 'asc' }, { startedAt: 'desc' }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      select: {
        id: true,
        code: true,
        title: true,
        status: true,
        severity: true,
        summary: true,
        startedAt: true,
        lastSeen: true,
        resolvedAt: true,
        mttrSeconds: true,
        reopenedCount: true,
        mergedIntoId: true,
        alerts: {
          where: { status: { not: 'SUPPRESSED' } },
          select: { id: true, fingerprint: { select: { device: { select: { name: true } } } } },
        },
      },
    }),
  ]);

  return {
    total,
    page: query.page,
    pageSize: query.pageSize,
    items: rows.map((r) => {
      const names = [...new Set(r.alerts.map((a) => a.fingerprint.device.name))].sort();
      return {
        id: r.id,
        code: r.code,
        title: r.title,
        status: r.status,
        severity: r.severity,
        summary: r.summary,
        startedAt: r.startedAt,
        lastSeen: r.lastSeen,
        resolvedAt: r.resolvedAt,
        mttrSeconds: r.mttrSeconds,
        alertCount: r.alerts.length,
        deviceCount: names.length,
        deviceNames: names,
        reopenedCount: r.reopenedCount,
        mergedIntoId: r.mergedIntoId,
      };
    }),
  };
}

export type IncidentStats = {
  open: number;
  closed: number;
  total: number;
  /** 最近 24 小时新增事件 */
  last24h: number;
};

export async function getIncidentStats(now: Date = new Date()): Promise<IncidentStats> {
  const [open, closed, total, last24h] = await Promise.all([
    db.incident.count({ where: { status: { in: ['OPEN', 'ANALYZING', 'LOCATED', 'MITIGATED'] } } }),
    db.incident.count({ where: { status: { in: ['RESOLVED', 'CLOSED'] } } }),
    db.incident.count(),
    db.incident.count({ where: { startedAt: { gte: new Date(now.getTime() - 24 * 3600_000) } } }),
  ]);
  return { open, closed, total, last24h };
}
