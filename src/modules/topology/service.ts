import type { DeviceType, LinkStatus, Severity } from '@prisma/client';
import { db } from '@/lib/db';

/** `GET /api/v1/topology` 的查询实现（文档 11 节第 6 条） */

export type TopologyNode = {
  id: string;
  name: string;
  type: DeviceType;
  layer: number;
  site: string | null;
  ip: string | null;
  /** 该设备上仍处于 ACTIVE 的告警数，画布用来打点 */
  activeAlertCount: number;
  maxSeverity: Severity | null;
  /** 该设备当前卷入的活跃事件（点节点时跳转用） */
  incidents: { id: string; code: string; title: string; severity: Severity }[];
};

export type TopologyEdge = {
  id: string;
  sourceId: string;
  targetId: string;
  bandwidth: number | null;
  status: LinkStatus;
};

export type TopologyGraph = {
  nodes: TopologyNode[];
  edges: TopologyEdge[];
  stats: {
    devices: number;
    links: number;
    byLayer: { core: number; agg: number; access: number };
    down: number;
    degraded: number;
    activeAlerts: number;
    affectedDevices: number;
  };
};

const SEVERITY_RANK: Record<Severity, number> = { P0: 4, P1: 3, P2: 2, P3: 1 };

export function maxSeverityOf(list: readonly Severity[]): Severity | null {
  let best: Severity | null = null;
  for (const s of list) {
    if (!best || SEVERITY_RANK[s] > SEVERITY_RANK[best]) best = s;
  }
  return best;
}

export async function getTopologyGraph(tenantId = 'default'): Promise<TopologyGraph> {
  const devices = await db.device.findMany({
    where: { tenantId },
    orderBy: [{ layer: 'asc' }, { name: 'asc' }],
    select: { id: true, name: true, type: true, layer: true, site: true, ip: true },
  });
  const deviceIds = devices.map((device) => device.id);
  const [links, alerts] = await Promise.all([
    db.topologyLink.findMany({
      where: { sourceId: { in: deviceIds }, targetId: { in: deviceIds } },
      orderBy: [{ sourceId: 'asc' }, { targetId: 'asc' }],
      select: { id: true, sourceId: true, targetId: true, bandwidth: true, status: true },
    }),
    db.alert.findMany({
      where: { tenantId, status: 'ACTIVE' },
      select: {
        severity: true,
        fingerprint: { select: { deviceId: true } },
        incident: { select: { id: true, code: true, title: true, severity: true, status: true } },
      },
    }),
  ]);

  type Acc = {
    count: number;
    severities: Severity[];
    incidents: Map<string, TopologyNode['incidents'][number]>;
  };
  const acc = new Map<string, Acc>();
  for (const alert of alerts) {
    const deviceId = alert.fingerprint.deviceId;
    let entry = acc.get(deviceId);
    if (!entry) {
      entry = { count: 0, severities: [], incidents: new Map() };
      acc.set(deviceId, entry);
    }
    entry.count += 1;
    entry.severities.push(alert.severity);
    if (
      alert.incident &&
      alert.incident.status !== 'CLOSED' &&
      alert.incident.status !== 'RESOLVED'
    ) {
      entry.incidents.set(alert.incident.id, {
        id: alert.incident.id,
        code: alert.incident.code,
        title: alert.incident.title,
        severity: alert.incident.severity,
      });
    }
  }

  const nodes: TopologyNode[] = devices.map((device) => {
    const entry = acc.get(device.id);
    return {
      ...device,
      activeAlertCount: entry?.count ?? 0,
      maxSeverity: entry ? maxSeverityOf(entry.severities) : null,
      incidents: entry ? [...entry.incidents.values()] : [],
    };
  });

  const byLayer = { core: 0, agg: 0, access: 0 };
  for (const node of nodes) {
    if (node.layer <= 1) byLayer.core += 1;
    else if (node.layer === 2) byLayer.agg += 1;
    else byLayer.access += 1;
  }

  return {
    nodes,
    edges: links,
    stats: {
      devices: nodes.length,
      links: links.length,
      byLayer,
      down: links.filter((l) => l.status === 'DOWN').length,
      degraded: links.filter((l) => l.status === 'DEGRADED').length,
      activeAlerts: alerts.length,
      affectedDevices: nodes.filter((n) => n.activeAlertCount > 0).length,
    },
  };
}
