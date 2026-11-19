import type { IncidentStatus, Severity } from '@prisma/client';
import type { AlertCluster, ClusterAlert } from './cluster';
import { CLUSTER_THRESHOLD, FOLLOWUP_LOOKBACK_MS } from './constants';
import { typeAffinity } from './affinity';
import { canRelate, scorePair } from './scoring';
import type { DeviceGraph } from './topology';

/**
 * 簇 ↔ 事件 的关联判定（B5 / B6）。
 * 与簇内打分共用同一套 scorePair，但比较对象从"告警↔告警"变成"告警↔事件内任一告警"。
 */

export type LoadedIncident = {
  id: string;
  code: string;
  status: IncidentStatus;
  startedAt: Date;
  lastSeen: Date;
  deviceIds: string[];
  alerts: ClusterAlert[];
};

export type IncidentRowWithAlerts = {
  id: string;
  code: string;
  status: IncidentStatus;
  startedAt: Date;
  lastSeen: Date;
  alerts: Array<{
    id: string;
    fingerprintId: string;
    severity: Severity;
    firstSeen: Date;
    lastSeen: Date;
    fingerprint: { deviceId: string; type: string; device: { name: string } };
  }>;
};

export function mapAlertRow(row: IncidentRowWithAlerts['alerts'][number]): ClusterAlert {
  return {
    id: row.id,
    fingerprintId: row.fingerprintId,
    deviceId: row.fingerprint.deviceId,
    deviceName: row.fingerprint.device.name,
    type: row.fingerprint.type,
    severity: row.severity,
    firstSeen: row.firstSeen,
    lastSeen: row.lastSeen,
  };
}

export function toLoadedIncident(row: IncidentRowWithAlerts): LoadedIncident {
  const alerts = row.alerts.map(mapAlertRow);
  return {
    id: row.id,
    code: row.code,
    status: row.status,
    startedAt: row.startedAt,
    lastSeen: row.lastSeen,
    deviceIds: [...new Set(alerts.map((a) => a.deviceId))],
    alerts,
  };
}

export type IncidentMatch = {
  incident: LoadedIncident;
  /** 簇内任一告警与事件内任一告警的最大关联分 */
  score: number;
  /** 共享设备数（去重） */
  deviceOverlap: number;
};

/**
 * B5：簇与事件的最大关联分。
 * 时间距离超过 2 小时的不参与比较 —— 否则同一设备三天前的旧告警会把新故障并进老事件。
 */
export function scoreClusterAgainstIncident(
  cluster: AlertCluster,
  incident: LoadedIncident,
  graph: DeviceGraph,
  now: Date,
): IncidentMatch {
  const clusterDevices = new Set(cluster.deviceIds);
  const incidentDevices = new Set(incident.alerts.map((a) => a.deviceId));
  let deviceOverlap = 0;
  for (const d of clusterDevices) if (incidentDevices.has(d)) deviceOverlap++;

  const horizon = now.getTime() - FOLLOWUP_LOOKBACK_MS;
  const ceiling = now.getTime();
  let best = 0;

  for (const a of cluster.alerts) {
    for (const b of incident.alerts) {
      // 锚点必须落在 [now-2h, now]：只设下界会把"晚于聚合时刻"的告警也当成锚点，
      // 历史基准的集成测试会因此把当天的事件并进来
      const at = b.firstSeen.getTime();
      if (at < horizon || at > ceiling) continue;
      if (!canRelate(graph, a, b)) continue;
      const score = scorePair(graph, a, b);
      if (score > best) best = score;
    }
  }

  return { incident, score: best, deviceOverlap };
}

/** 按分数降序，同分按 code 升序（确定性） */
export function rankIncidents(
  cluster: AlertCluster,
  incidents: readonly LoadedIncident[],
  graph: DeviceGraph,
  now: Date,
): IncidentMatch[] {
  return incidents
    .map((incident) => scoreClusterAgainstIncident(cluster, incident, graph, now))
    .filter((m) => m.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.incident.code.localeCompare(b.incident.code);
    });
}

export function bestIncidentAboveThreshold(
  matches: readonly IncidentMatch[],
): IncidentMatch | null {
  const first = matches[0];
  return first && first.score >= CLUSTER_THRESHOLD ? first : null;
}

/**
 * B6「同簇再现」判定：
 * 1) 指纹完全命中（同设备同类型同指标），或
 * 2) 同一批设备上出现同族告警（亲和度 ≥ 0.8）
 * 只有这两条算"同一个故障又回来了"，其余一律当新故障。
 */
export function matchesFault(cluster: AlertCluster, incident: LoadedIncident): boolean {
  const fingerprints = new Set(cluster.alerts.map((a) => a.fingerprintId));
  if (incident.alerts.some((a) => fingerprints.has(a.fingerprintId))) return true;

  const clusterDevices = new Set(cluster.deviceIds);
  const overlapping = incident.alerts.filter((a) => clusterDevices.has(a.deviceId));
  if (overlapping.length === 0) return false;

  let best = 0;
  for (const a of cluster.alerts) {
    for (const b of overlapping) {
      const affinity = typeAffinity(a.type, b.type);
      if (affinity > best) best = affinity;
    }
  }
  return best >= 0.8;
}
