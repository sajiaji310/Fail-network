import type { AlertStatus, IncidentStatus, Severity } from '@prisma/client';
import { db } from '@/lib/db';
import { parseAnalysisMeta, type AnalysisMeta } from '@/modules/rca/schema';
import {
  parseClosure,
  parseStatusLog,
  type ClosureRecord,
  type StatusLogEntry,
} from './closure-view';
import { aggregateIncidentDevices, type IncidentDevice } from './devices';
import { toHypothesisView, type HypothesisView } from './hypothesis-view';
import { buildTimeline, type TimelineItem } from './timeline';

export type { ClosureRecord, StatusLogEntry } from './closure-view';
export type { HypothesisView } from './hypothesis-view';
export type { IncidentDevice } from './devices';

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

export type IncidentChange = {
  id: string;
  deviceId: string;
  deviceName: string;
  kind: string;
  content: string;
  operator: string | null;
  changedAt: string;
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
  /** 上一次研判的审计信息（T07）：没有研判过则为 null */
  analysis: AnalysisMeta | null;
  /** 人工流转审计（T08）：按发生顺序 */
  statusLog: StatusLogEntry[];
  /** 结案记录（T08）：未结案为 null */
  closure: ClosureRecord | null;
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
      analysisMeta: true,
      statusLog: true,
      closure: true,
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
          model: true,
          evidence: true,
          verifySteps: true,
          actions: true,
          verdict: true,
          verdictAt: true,
          verdictNote: true,
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

  const devices = aggregateIncidentDevices(
    incident.alerts.map((a) => ({
      severity: a.severity,
      status: a.status,
      type: a.fingerprint.type,
      device: a.fingerprint.device,
    })),
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

  // 时间线与返回值共用同一份变更投影，避免两处字段口径漂移
  const timelineChanges = changes.map((c) => ({
    id: c.id,
    kind: c.kind,
    content: c.content,
    operator: c.operator,
    changedAt: c.changedAt,
    deviceId: c.device.id,
    deviceName: c.device.name,
  }));

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
    changes: timelineChanges,
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
    changes: timelineChanges.map((c) => ({ ...c, changedAt: c.changedAt.toISOString() })),
    hypotheses: incident.hypotheses.map(toHypothesisView),
    analysis: parseAnalysisMeta(incident.analysisMeta),
    statusLog: parseStatusLog(incident.statusLog),
    closure: parseClosure(incident.closure),
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
