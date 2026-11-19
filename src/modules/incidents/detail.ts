import type { AlertStatus, DeviceType, IncidentStatus, Severity } from '@prisma/client';
import { db } from '@/lib/db';
import { buildTimeline, type TimelineItem } from './timeline';

/**
 * 事件详情取数（文档 11 节第 13 条：含 alerts / hypotheses / timeline）。
 *
 * 输出全部是可序列化字段（日期转 ISO）：这份数据要跨 RSC → Client 边界
 * 传给三栏工作台，混进 Date 会在 Next 的序列化检查里直接报错。
 */

export type IncidentAlertRow = {
  id: string;
  type: string;
  metric: string | null;
  severity: Severity;
  status: AlertStatus;
  message: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  deviceId: string;
  deviceName: string;
  deviceLayer: number;
  suppressedByAlertId: string | null;
};

export type IncidentDevice = {
  id: string;
  name: string;
  type: DeviceType;
  layer: number;
  site: string | null;
  ip: string | null;
  alertCount: number;
  suppressedCount: number;
  maxSeverity: Severity;
  types: string[];
};

export type IncidentChange = {
  id: string;
  deviceId: string;
  deviceName: string;
  kind: string;
  content: string;
  operator: string | null;
  changedAt: string;
};

export type HypothesisView = {
  id: string;
  rank: number;
  cause: string;
  category: string;
  confidence: number;
  source: string;
  evidenceCount: number;
  verifyStepCount: number;
};

export type IncidentDetail = {
  id: string;
  code: string;
  title: string;
  status: IncidentStatus;
  severity: Severity;
  summary: string | null;
  impactScope: string | null;
  startedAt: string;
  lastSeen: string;
  locatedAt: string | null;
  resolvedAt: string | null;
  mttrSeconds: number | null;
  closedReason: string | null;
  reopenedCount: number;
  mergedIntoId: string | null;
  alerts: IncidentAlertRow[];
  devices: IncidentDevice[];
  changes: IncidentChange[];
  hypotheses: HypothesisView[];
  timeline: TimelineItem[];
  timelineTotal: number;
  timelineTruncated: boolean;
  stats: {
    alertCount: number;
    suppressedCount: number;
    deviceCount: number;
    changeCount: number;
    durationSeconds: number;
  };
};

/** 事件发生前多久内的变更算"可疑变更"（与 T07 证据窗口保持一致） */
export const CHANGE_LOOKBACK_MS = 2 * 60 * 60 * 1000;
/** 事件结束后仍可能补录变更，留 5 分钟尾巴 */
export const CHANGE_LOOKAHEAD_MS = 5 * 60 * 1000;

const SEVERITY_RANK: Record<Severity, number> = { P0: 4, P1: 3, P2: 2, P3: 1 };

function jsonLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

export async function getIncidentDetail(idOrCode: string): Promise<IncidentDetail | null> {
  const incident = await db.incident.findFirst({
    where: { OR: [{ id: idOrCode }, { code: idOrCode }] },
    select: {
      id: true,
      code: true,
      title: true,
      status: true,
      severity: true,
      summary: true,
      impactScope: true,
      startedAt: true,
      lastSeen: true,
      locatedAt: true,
      resolvedAt: true,
      mttrSeconds: true,
      closedReason: true,
      reopenedCount: true,
      mergedIntoId: true,
      alerts: {
        orderBy: [{ firstSeen: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          severity: true,
          status: true,
          message: true,
          count: true,
          firstSeen: true,
          lastSeen: true,
          suppressedByAlertId: true,
          fingerprint: {
            select: {
              type: true,
              metric: true,
              device: {
                select: { id: true, name: true, type: true, layer: true, site: true, ip: true },
              },
            },
          },
        },
      },
      hypotheses: {
        orderBy: { rank: 'asc' },
        select: {
          id: true,
          rank: true,
          cause: true,
          category: true,
          confidence: true,
          source: true,
          evidence: true,
          verifySteps: true,
        },
      },
    },
  });

  if (!incident) return null;

  const alerts: IncidentAlertRow[] = incident.alerts.map((a) => ({
    id: a.id,
    type: a.fingerprint.type,
    metric: a.fingerprint.metric,
    severity: a.severity,
    status: a.status,
    message: a.message,
    count: a.count,
    firstSeen: a.firstSeen.toISOString(),
    lastSeen: a.lastSeen.toISOString(),
    deviceId: a.fingerprint.device.id,
    deviceName: a.fingerprint.device.name,
    deviceLayer: a.fingerprint.device.layer,
    suppressedByAlertId: a.suppressedByAlertId,
  }));

  const deviceMap = new Map<string, IncidentDevice>();
  for (const alert of incident.alerts) {
    const device = alert.fingerprint.device;
    let entry = deviceMap.get(device.id);
    if (!entry) {
      entry = {
        id: device.id,
        name: device.name,
        type: device.type,
        layer: device.layer,
        site: device.site,
        ip: device.ip,
        alertCount: 0,
        suppressedCount: 0,
        maxSeverity: alert.severity,
        types: [],
      };
      deviceMap.set(device.id, entry);
    }
    entry.alertCount += 1;
    if (alert.status === 'SUPPRESSED') entry.suppressedCount += 1;
    if (SEVERITY_RANK[alert.severity] > SEVERITY_RANK[entry.maxSeverity]) {
      entry.maxSeverity = alert.severity;
    }
    if (!entry.types.includes(alert.fingerprint.type)) entry.types.push(alert.fingerprint.type);
  }

  const devices = [...deviceMap.values()].sort(
    (a, b) =>
      a.layer - b.layer ||
      SEVERITY_RANK[b.maxSeverity] - SEVERITY_RANK[a.maxSeverity] ||
      a.name.localeCompare(b.name),
  );

  const changes = devices.length
    ? await db.changeRecord.findMany({
        where: {
          deviceId: { in: devices.map((d) => d.id) },
          changedAt: {
            gte: new Date(incident.startedAt.getTime() - CHANGE_LOOKBACK_MS),
            lte: new Date(
              Math.max(incident.lastSeen.getTime(), incident.startedAt.getTime()) +
                CHANGE_LOOKAHEAD_MS,
            ),
          },
        },
        orderBy: { changedAt: 'asc' },
        select: {
          id: true,
          kind: true,
          content: true,
          operator: true,
          changedAt: true,
          device: { select: { id: true, name: true } },
        },
      })
    : [];

  const timeline = buildTimeline({
    incident: {
      id: incident.id,
      code: incident.code,
      title: incident.title,
      startedAt: incident.startedAt,
      lastSeen: incident.lastSeen,
      resolvedAt: incident.resolvedAt,
    },
    alerts: incident.alerts.map((a) => ({
      id: a.id,
      type: a.fingerprint.type,
      severity: a.severity,
      status: a.status,
      message: a.message,
      count: a.count,
      firstSeen: a.firstSeen,
      lastSeen: a.lastSeen,
      deviceId: a.fingerprint.device.id,
      deviceName: a.fingerprint.device.name,
      suppressedBy: a.suppressedByAlertId,
    })),
    changes: changes.map((c) => ({
      id: c.id,
      kind: c.kind,
      content: c.content,
      operator: c.operator,
      changedAt: c.changedAt,
      deviceId: c.device.id,
      deviceName: c.device.name,
    })),
  });

  const durationSeconds =
    (incident.resolvedAt ?? new Date()).getTime() - incident.startedAt.getTime();

  return {
    id: incident.id,
    code: incident.code,
    title: incident.title,
    status: incident.status,
    severity: incident.severity,
    summary: incident.summary,
    impactScope: incident.impactScope,
    startedAt: incident.startedAt.toISOString(),
    lastSeen: incident.lastSeen.toISOString(),
    locatedAt: incident.locatedAt?.toISOString() ?? null,
    resolvedAt: incident.resolvedAt?.toISOString() ?? null,
    mttrSeconds: incident.mttrSeconds,
    closedReason: incident.closedReason,
    reopenedCount: incident.reopenedCount,
    mergedIntoId: incident.mergedIntoId,
    alerts,
    devices,
    changes: changes.map((c) => ({
      id: c.id,
      deviceId: c.device.id,
      deviceName: c.device.name,
      kind: c.kind,
      content: c.content,
      operator: c.operator,
      changedAt: c.changedAt.toISOString(),
    })),
    hypotheses: incident.hypotheses.map((h) => ({
      id: h.id,
      rank: h.rank,
      cause: h.cause,
      category: h.category,
      confidence: h.confidence,
      source: h.source,
      evidenceCount: jsonLength(h.evidence),
      verifyStepCount: jsonLength(h.verifySteps),
    })),
    timeline: timeline.items,
    timelineTotal: timeline.total,
    timelineTruncated: timeline.truncated,
    stats: {
      alertCount: alerts.length,
      suppressedCount: alerts.filter((a) => a.status === 'SUPPRESSED').length,
      deviceCount: devices.length,
      changeCount: changes.length,
      durationSeconds: Math.max(0, Math.round(durationSeconds / 1000)),
    },
  };
}
