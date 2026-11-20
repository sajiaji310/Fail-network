import type { AlertStatus, IncidentStatus, Severity } from '@prisma/client';
import { db } from '@/lib/db';
import { getAffectedServices, type AffectedService } from '@/modules/business/impact';
import { parseAnalysisMeta, type AnalysisMeta } from '@/modules/rca/schema';
import {
  parseClosure,
  parseStatusLog,
  type ClosureRecord,
  type StatusLogEntry,
} from './closure-view';
import {
  assessTopology,
  coverageNote,
  type TopologyCoverage,
} from '@/modules/topology/completeness';
import { aggregateIncidentDevices, type IncidentDevice } from './devices';
import { toHypothesisView, type HypothesisView } from './hypothesis-view';
import { assessResponse, derivePhase, type IncidentPhase, type ResponseInfo } from './sla';
import { buildTimeline, type TimelineItem } from './timeline';

export type { ClosureRecord, StatusLogEntry } from './closure-view';
export type { HypothesisView } from './hypothesis-view';
export type { IncidentDevice } from './devices';
export type { AffectedService } from '@/modules/business/impact';

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
  /** 拓扑完整度（评审 P0-4）：缺拓扑时页面把结论降级为候选排序 */
  topology: TopologyCoverage;
  topologyNote: string | null;
  /** 责任人（评审第 3 阶段）：未接手为 null */
  assignee: string | null;
  team: string | null;
  claimedAt: string | null;
  /** 响应时限判定：未接手 / 在时限内 / 即将超时 / 已超时 / 已结束 */
  response: ResponseInfo;
  /** 当前阶段（由状态 + 责任人 + 结论派生，不落库） */
  phase: IncidentPhase;
  /** 受影响的业务服务（事件设备 ∩ 服务依赖设备） */
  services: AffectedService[];
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

export async function getIncidentDetail(
  idOrCode: string,
  tenantId = 'default',
): Promise<IncidentDetail | null> {
  const incident = await db.incident.findFirst({
    where: { tenantId, OR: [{ id: idOrCode }, { code: idOrCode }] },
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
      assignee: true,
      team: true,
      claimedAt: true,
      slaMinutes: true,
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
          verifyChecks: {
            orderBy: { stepIndex: 'asc' },
            select: { stepIndex: true, note: true, by: true, at: true },
          },
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

  // 拓扑取全量链路：连通性判定允许经过非事件设备（核心 → 汇聚常经中间设备），
  // 只查"紧邻事件设备"的链路会把正常拓扑误判成断裂。
  const [changes, linkRows, services] = await Promise.all([
    devices.length
      ? db.changeRecord.findMany({
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
      : Promise.resolve([]),
    db.topologyLink.findMany({ select: { sourceId: true, targetId: true } }),
    getAffectedServices(devices.map((d) => d.id)),
  ]);

  const topology = assessTopology(
    devices.map((d) => ({ id: d.id, name: d.name })),
    linkRows,
  );

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

  const response = assessResponse({
    severity: incident.severity,
    status: incident.status,
    startedAt: incident.startedAt,
    claimedAt: incident.claimedAt,
    slaMinutes: incident.slaMinutes,
  });

  const phase = derivePhase({
    status: incident.status,
    assignee: incident.assignee,
    hasAnalysis: incident.hypotheses.length > 0,
    hasAccepted: incident.hypotheses.some((h) => h.verdict === 'ACCEPTED'),
  });

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
    topology,
    topologyNote: coverageNote(topology),
    assignee: incident.assignee,
    team: incident.team,
    claimedAt: incident.claimedAt?.toISOString() ?? null,
    response,
    phase,
    services,
    stats: {
      alertCount: alerts.length,
      suppressedCount: alerts.filter((a) => a.status === 'SUPPRESSED').length,
      deviceCount: devices.length,
      changeCount: changes.length,
      durationSeconds: Math.max(0, Math.round(durationSeconds / 1000)),
    },
  };
}
