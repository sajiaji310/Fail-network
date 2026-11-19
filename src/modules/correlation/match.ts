import type { IncidentStatus, Severity } from '@prisma/client';
import type { AlertCluster, ClusterAlert } from './cluster';
import { CLUSTER_THRESHOLD, CONTINUATION_WINDOW_MS, FOLLOWUP_LOOKBACK_MS } from './constants';
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
 *
 * 两个时间约束，缺一不可：
 * 1) 锚点取事件内该告警的 **lastSeen**（还在持续的那条），不是 firstSeen ——
 *    用 firstSeen 时，一场持续 10 分钟的故障，第 8 分钟的新告警与"第 0 分钟那条"相差 8 分钟，
 *    时间项直接归零，只剩拓扑 0.45 + 类型 0.2 = 0.65，靠拓扑硬扛；一旦设备不同就掉到阈值下。
 * 2) 新告警与锚点的间隔不得超过 30 分钟延续窗。同设备 + 同类型的光靠公式能拿 0.65，
 *    没有这道闸门，100 分钟后的第二次发生会被并进上一场故障（AC-14 失败）。
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
      const anchorMs = b.lastSeen.getTime();
      if (anchorMs < horizon || anchorMs > ceiling) continue;
      if (Math.abs(a.firstSeen.getTime() - anchorMs) > CONTINUATION_WINDOW_MS) continue;
      if (!canRelate(graph, a, b)) continue;
      const score = scorePair(graph, a, { ...b, firstSeen: b.lastSeen });
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
 * B5 跨窗口延续：同一设备簇在事件最近上报后 30 分钟内再现。
 *
 * 与 `scoreClusterAgainstIncident` 的分工：那边是"两条告警像不像同一个故障"（5 分钟窗打分），
 * 这边是"同一场故障还在继续"（共享设备 + 时间连续）。静默跨窗口的持续故障必须走这条路，
 * 否则时间项归零后分数必然掉到阈值下，被拆成两个事件。
 */
export function findContinuation(
  cluster: AlertCluster,
  incidents: readonly LoadedIncident[],
  graph: DeviceGraph,
  now: Date,
): LoadedIncident | null {
  const clusterStart = cluster.alerts.reduce(
    (min, a) => (a.firstSeen.getTime() < min ? a.firstSeen.getTime() : min),
    cluster.alerts[0]?.firstSeen.getTime() ?? now.getTime(),
  );

  let best: { incident: LoadedIncident; gap: number; score: number } | null = null;
  for (const incident of incidents) {
    const lastSeenMs = incident.lastSeen.getTime();
    if (lastSeenMs > now.getTime()) continue;
    const gap = Math.abs(clusterStart - lastSeenMs);
    if (gap > CONTINUATION_WINDOW_MS) continue;

    // 时间项按 30 分钟归一化，而不是 5 分钟窗口：这条判定问的是"还在继续吗"，
    // 不是"像不像同一个 5 分钟内的告警"。
    let score = 0;
    for (const a of cluster.alerts) {
      for (const b of incident.alerts) {
        if (!canRelate(graph, a, b)) continue;
        const candidate = scorePair(
          graph,
          a,
          { ...b, firstSeen: incident.lastSeen },
          CONTINUATION_WINDOW_MS,
        );
        if (candidate > score) score = candidate;
      }
    }
    if (score < CLUSTER_THRESHOLD) continue;
    if (!best || gap < best.gap) best = { incident, gap, score };
  }
  return best?.incident ?? null;
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
