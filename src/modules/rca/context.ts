import { db } from '@/lib/db';
import { alertTypeLabel } from '@/modules/alerts/labels';
import { classifyAlertType } from '@/modules/alerts/taxonomy';
import { MAX_HOPS, UNREACHABLE_HOPS } from '@/modules/correlation/constants';
import { buildDeviceGraph } from '@/modules/correlation/topology';
import {
  MAX_ALERTS_IN_CONTEXT,
  MAX_CASES_IN_CONTEXT,
  MAX_METRICS_IN_CONTEXT,
  sortContextAlerts,
  trimBundle,
} from './context-trim';
import type {
  ContextAlert,
  ContextBundle,
  ContextCase,
  ContextChange,
  ContextLink,
  ContextMetric,
  ContextNode,
} from './context-types';
import { isCaseRelevant } from './relevance';
import { assessTopology } from '@/modules/topology/completeness';

export type {
  ContextAlert,
  ContextBundle,
  ContextCase,
  ContextChange,
  ContextLink,
  ContextMetric,
  ContextNode,
} from './context-types';

/**
 * 研判上下文组装（文档 10.1）。单次研判输入控在 6k tokens 内，
 * 裁剪逻辑在 `context-trim.ts`，本文件只做取数与归一。
 *
 * 数据现状：库里没有独立指标表，CPU/内存/端口错包只能取告警自带的 value/threshold，
 * 即"上报那一刻的快照"。有损（没有时间序列），但比编造强；prompt 里会标注来源，
 * 避免模型把它当趋势推理。
 */

export const CHANGE_LOOKBACK_HOURS = 24;

export async function buildIncidentContext(idOrCode: string): Promise<ContextBundle | null> {
  const incident = await db.incident.findFirst({
    where: { OR: [{ id: idOrCode }, { code: idOrCode }] },
    include: { alerts: { include: { fingerprint: { include: { device: true } } } } },
  });
  if (!incident) return null;

  const [allLinks, allDevices] = await Promise.all([
    db.topologyLink.findMany({
      select: { id: true, sourceId: true, targetId: true, status: true },
    }),
    db.device.findMany({ select: { id: true, name: true } }),
  ]);
  const graph = buildDeviceGraph(allLinks);
  const nameOf = new Map(allDevices.map((d) => [d.id, d.name]));

  const deviceMap = new Map<string, ContextNode>();
  for (const alert of incident.alerts) {
    const device = alert.fingerprint.device;
    if (deviceMap.has(device.id)) continue;
    deviceMap.set(device.id, {
      id: device.id,
      name: device.name,
      type: device.type,
      layer: device.layer,
      site: device.site,
    });
  }
  const nodes = [...deviceMap.values()];
  const incidentDeviceIds = [...deviceMap.keys()];

  const firstAlertAt =
    incident.alerts.reduce<Date | null>((acc, a) => {
      if (!acc) return a.firstSeen;
      return a.firstSeen < acc ? a.firstSeen : acc;
    }, null) ?? incident.startedAt;

  const alerts: ContextAlert[] = incident.alerts
    .map((a) => ({
      id: a.id,
      deviceId: a.fingerprint.device.id,
      deviceName: a.fingerprint.device.name,
      deviceLayer: a.fingerprint.device.layer,
      type: a.fingerprint.type,
      typeLabel: alertTypeLabel(a.fingerprint.type),
      alertClass: classifyAlertType(a.fingerprint.type),
      metric: a.fingerprint.metric,
      severity: a.severity,
      status: a.status,
      count: a.count,
      value: a.value,
      threshold: a.threshold,
      firstSeen: a.firstSeen.toISOString(),
      lastSeen: a.lastSeen.toISOString(),
      message: a.message,
      suppressed: a.status === 'SUPPRESSED',
    }))
    .sort(sortContextAlerts)
    .slice(0, MAX_ALERTS_IN_CONTEXT);

  const metrics: ContextMetric[] = alerts
    .filter((a) => a.value !== null || a.threshold !== null)
    .slice(0, MAX_METRICS_IN_CONTEXT)
    .map((a) => ({
      deviceId: a.deviceId,
      deviceName: a.deviceName,
      metric: a.metric ?? a.type,
      value: a.value,
      threshold: a.threshold,
      at: a.firstSeen,
    }));

  /** 某设备到事件影响面的最小跳数（影响面内为 0） */
  const hopsFrom = (deviceId: string): number => {
    let best = UNREACHABLE_HOPS;
    for (const id of incidentDeviceIds) {
      const h = graph.hop(id, deviceId);
      if (h < best) best = h;
      if (best === 0) return 0;
    }
    return best;
  };

  const links: ContextLink[] = [];
  for (const link of allLinks) {
    // 只要"至少一端在 2 跳内"的链路：两端都在 3 跳外的链路与本次研判无关
    const hopsToIncident = Math.min(hopsFrom(link.sourceId), hopsFrom(link.targetId));
    if (hopsToIncident > MAX_HOPS) continue;
    links.push({
      id: link.id,
      sourceId: link.sourceId,
      targetId: link.targetId,
      sourceName: nameOf.get(link.sourceId) ?? link.sourceId,
      targetName: nameOf.get(link.targetId) ?? link.targetId,
      status: link.status,
      hopsToIncident,
    });
  }

  const firstAlertMs = firstAlertAt.getTime();
  const windowStart = new Date(firstAlertMs - CHANGE_LOOKBACK_HOURS * 60 * 60 * 1000);
  const scopedDeviceIds = new Set<string>([
    ...incidentDeviceIds,
    ...links.flatMap((l) => [l.sourceId, l.targetId]),
  ]);
  const changeRows = await db.changeRecord.findMany({
    where: {
      deviceId: { in: [...scopedDeviceIds] },
      changedAt: { gte: windowStart, lte: incident.lastSeen },
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
  });

  const changes: ContextChange[] = changeRows.map((c) => ({
    id: c.id,
    deviceId: c.device.id,
    deviceName: c.device.name,
    kind: c.kind,
    content: c.content,
    operator: c.operator,
    changedAt: c.changedAt.toISOString(),
    beforeFirstAlert: c.changedAt.getTime() < firstAlertMs,
  }));

  const alertTypes = [...new Set(incident.alerts.map((a) => a.fingerprint.type))];
  const cases = await recallCases(alertTypes);

  const bundle: ContextBundle = {
    incident: {
      id: incident.id,
      code: incident.code,
      title: incident.title,
      severity: incident.severity,
      status: incident.status,
      startedAt: incident.startedAt.toISOString(),
      lastSeen: incident.lastSeen.toISOString(),
      firstAlertAt: firstAlertAt.toISOString(),
      deviceCount: nodes.length,
      alertCount: incident.alerts.length,
      suppressedCount: incident.alerts.filter((a) => a.status === 'SUPPRESSED').length,
    },
    nodes,
    links,
    alerts,
    metrics,
    changes,
    cases,
    topology: assessTopology(
      nodes.map((n) => ({ id: n.id, name: n.name })),
      allLinks,
    ),
    graph,
    trim: { trimmed: [], chars: 0 },
  };

  return trimBundle(bundle);
}

/**
 * 案例召回（ADR-002：量 < 1000 时用 tag 交集过滤 + 内存排序，不上向量库）。
 *
 * **只召回 VERIFIED**（评审 P0-3）：未经人工确认的机器猜测一旦进入上下文，
 * 就会被下一轮研判当成"历史经验"引用，错误会自我放大。
 * UNVERIFIED 的案例在案例库里照常可查，只是不参与召回。
 */
async function recallCases(alertTypes: string[]): Promise<ContextCase[]> {
  const rows = await db.caseRecord.findMany({
    where: { verification: 'VERIFIED' },
    orderBy: { createdAt: 'desc' },
    take: 200,
    select: {
      id: true,
      title: true,
      symptom: true,
      rootCause: true,
      resolution: true,
      tags: true,
    },
  });
  return rows
    .map((c) => ({
      id: c.id,
      title: c.title,
      symptom: c.symptom,
      rootCause: c.rootCause,
      resolution: c.resolution,
      tags: c.tags,
      relevant: isCaseRelevant(c.tags, alertTypes),
    }))
    .filter((c) => c.relevant)
    .slice(0, MAX_CASES_IN_CONTEXT);
}
