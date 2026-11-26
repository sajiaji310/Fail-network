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
import { loadTrends, metricRef } from '@/modules/metrics/service';

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
 * 数据现状：告警自带 value/threshold 是"上报那一刻的快照"；第 4 阶段接入 `MetricSample`
 * 之后，事件窗口内的采样点会补上首末值、峰值与斜率。**没有采样时不要谈趋势** ——
 * prompt 与上下文数据都按这个口径区分（source=ALERT vs SAMPLE）。
 */

export const CHANGE_LOOKBACK_HOURS = 24;
/** 指标快照回看窗口：事件前 30 分钟足够看出爬升，不会把上下文预算吃光 */
export const METRIC_LOOKBACK_MS = 30 * 60_000;

export async function buildIncidentContext(
  idOrCode: string,
  tenantId = 'default',
): Promise<ContextBundle | null> {
  const incident = await db.incident.findFirst({
    where: { tenantId, OR: [{ id: idOrCode }, { code: idOrCode }] },
    include: { alerts: { include: { fingerprint: { include: { device: true } } } } },
  });
  if (!incident) return null;

  const [allLinks, allDevices] = await Promise.all([
    db.topologyLink.findMany({
      where: { source: { tenantId }, target: { tenantId } },
      select: { id: true, sourceId: true, targetId: true, status: true },
    }),
    db.device.findMany({ where: { tenantId }, select: { id: true, name: true } }),
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

  const metrics: ContextMetric[] = [];
  {
    const alertMetrics: ContextMetric[] = alerts
      .filter((a) => a.value !== null || a.threshold !== null)
      .map((a) => ({
        ref: metricRef(a.deviceName, a.metric ?? a.type),
        deviceId: a.deviceId,
        deviceName: a.deviceName,
        metric: a.metric ?? a.type,
        value: a.value,
        threshold: a.threshold,
        unit: null,
        at: a.firstSeen,
        source: 'ALERT' as const,
      }));

    // 指标快照只看事件前后这一段：更早的曲线与本次故障无关，且会把上下文预算吃掉
    const trends = await loadTrends(
      incidentDeviceIds,
      new Date(firstAlertAt.getTime() - METRIC_LOOKBACK_MS),
      incident.lastSeen,
    );

    for (const item of alertMetrics) {
      const trend = trends.get(`${item.deviceId}|${item.metric}`);
      metrics.push(trend ? { ...item, trend } : item);
    }
    const covered = new Set(metrics.map((m) => `${m.deviceId}|${m.metric}`));
    for (const [key, trend] of trends) {
      if (covered.has(key)) continue;
      const deviceName = nameOf.get(trend.deviceId) ?? trend.deviceId;
      metrics.push({
        ref: metricRef(deviceName, trend.metric),
        deviceId: trend.deviceId,
        deviceName,
        metric: trend.metric,
        value: trend.last,
        threshold: null,
        unit: trend.unit,
        at: trend.to,
        source: 'SAMPLE',
        trend,
      });
    }
    // 有曲线的排前面：模型读到的第一屏最好是有趋势的证据，而不是只有瞬时值的那几条
    metrics.sort((a, b) => Number(!!b.trend) - Number(!!a.trend));
  }

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
  const cases = await recallCases(alertTypes, tenantId);

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
    metrics: metrics.slice(0, MAX_METRICS_IN_CONTEXT),
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
async function recallCases(alertTypes: string[], tenantId: string): Promise<ContextCase[]> {
  const rows = await db.caseRecord.findMany({
    where: { tenantId, verification: 'VERIFIED' },
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
