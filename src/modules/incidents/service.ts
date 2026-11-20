import type { IncidentStatus, Prisma, Severity } from '@prisma/client';
import { db } from '@/lib/db';
import {
  mapAffectedServicesByDevice,
  mergeServices,
  type AffectedService,
} from '@/modules/business/impact';
import { assessResponse, derivePhase, type IncidentPhase, type ResponseInfo } from './sla';

/** `GET /api/v1/incidents` 的查询实现（文档 11 节第 12 条） */

/**
 * 值班队列（评审 5.1「增加未研判/证据不足/等待人工确认三个工作队列」）。
 *
 * 在 SQL 里过滤而不是取回来再筛：队列是"当前需要人动手的全部"，
 * 分页之后前端再筛会把队列条数算错。
 */
export type IncidentQueue = 'UNASSIGNED' | 'UNANALYZED' | 'AWAITING_CONFIRM';

export type IncidentListQuery = {
  status?: IncidentStatus[];
  severity?: Severity[];
  from?: Date;
  to?: Date;
  queue?: IncidentQueue;
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
  assignee: string | null;
  team: string | null;
  claimedAt: Date | null;
  response: ResponseInfo;
  phase: IncidentPhase;
  /** 受影响的业务服务：total 用于列表计数，names 只保留关键业务的短名 */
  services: { total: number; critical: string[] };
};

const ACTIVE_STATUSES: IncidentStatus[] = ['OPEN', 'ANALYZING', 'LOCATED', 'MITIGATED'];

export type IncidentListResult = {
  items: IncidentListItem[];
  total: number;
  page: number;
  pageSize: number;
};
function queueFilter(queue: IncidentQueue): Prisma.IncidentWhereInput {
  switch (queue) {
    case 'UNASSIGNED':
      return { assignee: null, status: { in: ACTIVE_STATUSES } };
    case 'UNANALYZED':
      return { status: { in: ACTIVE_STATUSES }, hypotheses: { none: {} } };
    case 'AWAITING_CONFIRM':
      return {
        status: { in: ACTIVE_STATUSES },
        hypotheses: { some: {}, none: { verdict: 'ACCEPTED' } },
      };
  }
}

export async function listIncidents(query: IncidentListQuery): Promise<IncidentListResult> {
  const where: Prisma.IncidentWhereInput = {
    ...(query.status?.length ? { status: { in: query.status } } : {}),
    ...(query.severity?.length ? { severity: { in: query.severity } } : {}),
    ...(query.queue ? queueFilter(query.queue) : {}),
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
        assignee: true,
        team: true,
        claimedAt: true,
        slaMinutes: true,
        alerts: {
          where: { status: { not: 'SUPPRESSED' } },
          select: {
            id: true,
            fingerprint: { select: { device: { select: { id: true, name: true } } } },
          },
        },
        hypotheses: { where: { verdict: 'ACCEPTED' }, select: { id: true }, take: 1 },
        _count: { select: { hypotheses: true } },
      },
    }),
  ]);

  // 服务影响面一次查完再按设备分组，避免每行一次往返
  const allDeviceIds = [
    ...new Set(rows.flatMap((r) => r.alerts.map((a) => a.fingerprint.device.id))),
  ];
  const servicesByDevice = await mapAffectedServicesByDevice(allDeviceIds);

  return {
    total,
    page: query.page,
    pageSize: query.pageSize,
    items: rows.map((r) => {
      const names = [...new Set(r.alerts.map((a) => a.fingerprint.device.name))].sort();
      const deviceIds = [...new Set(r.alerts.map((a) => a.fingerprint.device.id))];
      const services: AffectedService[] = mergeServices(
        deviceIds.map((id) => servicesByDevice.get(id) ?? []),
      );
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
        assignee: r.assignee,
        team: r.team,
        claimedAt: r.claimedAt,
        response: assessResponse({
          severity: r.severity,
          status: r.status,
          startedAt: r.startedAt,
          claimedAt: r.claimedAt,
          slaMinutes: r.slaMinutes,
        }),
        phase: derivePhase({
          status: r.status,
          assignee: r.assignee,
          hasAnalysis: r._count.hypotheses > 0,
          hasAccepted: r.hypotheses.length > 0,
        }),
        services: {
          total: services.length,
          critical: services.filter((s) => s.tier === 1).map((s) => s.name),
        },
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
  /** 活跃且无人接手 */
  unassigned: number;
  /** 活跃且有负责人 */
  assigned: number;
  /** 响应时限已超（含未接手就超时、接手晚于目标） */
  breached: number;
  /** 剩余时间不足 20% 或已超时，需要马上处理 */
  atRisk: number;
  /** 有结论但没人拍板 */
  awaitingConfirm: number;
  /** 还没研判过 */
  unanalyzed: number;
};

export async function getIncidentStats(now: Date = new Date()): Promise<IncidentStats> {
  const [active, closed, total, last24h, awaitingConfirm, unanalyzed] = await Promise.all([
    db.incident.findMany({
      where: { status: { in: ACTIVE_STATUSES } },
      // 活跃事件数量天然有限（一次故障一个），取全字段在内存里判时限，
      // 比在 SQL 里按严重级拼四条 OR 更不容易和 assessResponse 判歪
      select: {
        severity: true,
        status: true,
        startedAt: true,
        claimedAt: true,
        slaMinutes: true,
        assignee: true,
      },
    }),
    db.incident.count({ where: { status: { in: ['RESOLVED', 'CLOSED'] } } }),
    db.incident.count(),
    db.incident.count({ where: { startedAt: { gte: new Date(now.getTime() - 24 * 3600_000) } } }),
    db.incident.count({
      where: {
        status: { in: ACTIVE_STATUSES },
        hypotheses: { some: {}, none: { verdict: 'ACCEPTED' } },
      },
    }),
    db.incident.count({ where: { status: { in: ACTIVE_STATUSES }, hypotheses: { none: {} } } }),
  ]);

  let unassigned = 0;
  let assigned = 0;
  let breached = 0;
  let atRisk = 0;
  for (const row of active) {
    const response = assessResponse(
      {
        severity: row.severity,
        status: row.status,
        startedAt: row.startedAt,
        claimedAt: row.claimedAt,
        slaMinutes: row.slaMinutes,
      },
      now,
    );
    if (row.assignee) assigned += 1;
    else unassigned += 1;
    if (response.state === 'BREACHED') breached += 1;
    if (response.state === 'BREACHED' || response.state === 'DUE_SOON') atRisk += 1;
  }

  return {
    open: active.length,
    closed,
    total,
    last24h,
    unassigned,
    assigned,
    breached,
    atRisk,
    awaitingConfirm,
    unanalyzed,
  };
}
