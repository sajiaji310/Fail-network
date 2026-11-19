import { Prisma, type IncidentStatus } from '@prisma/client';
import { db } from '@/lib/db';
import { clusterKeyOf } from '../alerts/fingerprint';
import { clusterAlerts, type AlertCluster, type ClusterAlert } from './cluster';
import {
  ACTIVE_INCIDENT_STATUSES,
  CLOSED_INCIDENT_STATUSES,
  CLUSTER_THRESHOLD,
  FOLLOWUP_LOOKBACK_MS,
  MIN_ALERTS_PER_INCIDENT,
  REOPEN_WINDOW_MS,
  SCORE_TIE_EPSILON,
} from './constants';
import {
  bestIncidentAboveThreshold,
  findContinuation,
  mapAlertRow,
  matchesFault,
  rankIncidents,
  toLoadedIncident,
  type LoadedIncident,
} from './match';
import { checkMergeable, mergeIncidents, type MergeCandidate } from './merge';
import {
  attachAlerts,
  buildIncidentTitle,
  isClosedStatus,
  maxSeverity,
  nextIncidentCode,
  refreshIncidentAggregate,
  reopenIncident,
} from './persist';
import { buildDeviceGraph, type DeviceGraph } from './topology';

/** 同簇再现的追溯范围：只回看 24 小时内的结案事件 */
const RECURRENCE_LOOKBACK_MS = 24 * 60 * 60 * 1000;

const ALERT_SELECT = {
  id: true,
  fingerprintId: true,
  severity: true,
  firstSeen: true,
  lastSeen: true,
  incidentId: true,
  fingerprint: {
    select: {
      deviceId: true,
      type: true,
      device: { select: { name: true } },
    },
  },
} satisfies Prisma.AlertSelect;

const INCIDENT_SELECT = {
  id: true,
  code: true,
  status: true,
  startedAt: true,
  lastSeen: true,
  resolvedAt: true,
  alerts: {
    where: { status: { not: 'SUPPRESSED' as const } },
    select: {
      id: true,
      fingerprintId: true,
      severity: true,
      firstSeen: true,
      lastSeen: true,
      fingerprint: {
        select: {
          deviceId: true,
          type: true,
          device: { select: { name: true } },
        },
      },
    },
  },
} satisfies Prisma.IncidentSelect;

export type CorrelationSummary = {
  consideredAlerts: number;
  freshAlerts: number;
  clusters: number;
  created: Array<{ id: string; code: string; alerts: number }>;
  updated: Array<{ id: string; code: string; added: number }>;
  reopened: Array<{ id: string; code: string; reopenedCount: number }>;
  merged: Array<{ from: string; into: string; movedAlerts: number }>;
  noiseAlerts: number;
  durationMs: number;
};

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

async function loadGraph(): Promise<DeviceGraph> {
  const links = await db.topologyLink.findMany({ select: { sourceId: true, targetId: true } });
  return buildDeviceGraph(links);
}

type ClosedCandidate = { kind: 'recent' | 'older'; incident: LoadedIncident };

function toMergeCandidate(incident: LoadedIncident): MergeCandidate {
  return {
    id: incident.id,
    code: incident.code,
    startedAt: incident.startedAt,
    lastSeen: incident.lastSeen,
    deviceIds: incident.deviceIds,
  };
}

/**
 * 聚合主流程（第 4.1 节「步 3」+ 4.2 B1–B9）。
 *
 * 分两段：
 * 1) 未归属事件的告警做内存聚类 → 成簇（≤5 分钟窗口、≤2 跳、分 ≥ 0.55）
 * 2) 每个簇决定归属：沿用已有事件（B5/B8）→ 重开结案事件（B6）→ 新建
 * 最后跑一遍事件级合并（B3/B7）。
 *
 * 幂等：同一批告警重复执行，簇与 clusterKey 不变，命中的是同一个 Incident（AC-17）。
 */
export async function runCorrelation(now: Date = new Date()): Promise<CorrelationSummary> {
  const startedAtMs = Date.now();
  const graph = await loadGraph();
  const followupHorizon = new Date(now.getTime() - FOLLOWUP_LOOKBACK_MS);
  const recurrenceHorizon = new Date(now.getTime() - RECURRENCE_LOOKBACK_MS);

  const [alertRows, incidentRows, closedRows] = await Promise.all([
    db.alert.findMany({
      where: {
        status: 'ACTIVE',
        // 只看"截至聚合时刻"仍活跃的告警：上界必须卡住，
        // 否则时钟偏差或历史基准测试会把未来的告警也拉进来
        lastSeen: { gte: followupHorizon, lte: now },
        OR: [{ incidentId: null }, { incident: { status: { in: [...ACTIVE_INCIDENT_STATUSES] } } }],
      },
      orderBy: [{ firstSeen: 'asc' }, { id: 'asc' }],
      select: ALERT_SELECT,
    }),
    db.incident.findMany({
      where: { status: { in: [...ACTIVE_INCIDENT_STATUSES] } },
      orderBy: [{ code: 'asc' }],
      select: INCIDENT_SELECT,
    }),
    db.incident.findMany({
      where: {
        status: { in: [...CLOSED_INCIDENT_STATUSES] },
        resolvedAt: { gte: recurrenceHorizon, lte: now },
      },
      orderBy: [{ resolvedAt: 'desc' }],
      select: INCIDENT_SELECT,
    }),
  ]);

  const candidates = alertRows.map((row) => ({
    ...mapAlertRow(row),
    incidentId: row.incidentId,
  }));
  const fresh = candidates.filter((a) => a.incidentId === null);
  const clusters = clusterAlerts(fresh, graph);

  let active: LoadedIncident[] = incidentRows.map(toLoadedIncident);
  const closed: ClosedCandidate[] = closedRows.map((row) => {
    const incident = toLoadedIncident(row);
    const resolvedMs = (row.resolvedAt ?? row.lastSeen).getTime();
    const recent = now.getTime() - resolvedMs <= REOPEN_WINDOW_MS;
    return { kind: recent ? 'recent' : 'older', incident };
  });

  const summary: CorrelationSummary = {
    consideredAlerts: candidates.length,
    freshAlerts: fresh.length,
    clusters: clusters.length,
    created: [],
    updated: [],
    reopened: [],
    merged: [],
    noiseAlerts: 0,
    durationMs: 0,
  };

  const touchActive = (incident: LoadedIncident, added: readonly ClusterAlert[]): void => {
    const existing = active.find((i) => i.id === incident.id);
    if (existing) {
      existing.alerts = [...existing.alerts, ...added];
      existing.deviceIds = [...new Set(existing.alerts.map((a) => a.deviceId))];
      existing.status = 'OPEN';
      const latest = added.reduce(
        (max, a) => (a.lastSeen > max ? a.lastSeen : max),
        existing.lastSeen,
      );
      existing.lastSeen = latest;
      return;
    }
    active.push({
      ...incident,
      status: 'OPEN',
      alerts: [...incident.alerts, ...added],
      deviceIds: [...new Set([...incident.alerts, ...added].map((a) => a.deviceId))],
    });
  };

  const createIncident = async (
    cluster: AlertCluster,
    reopenedFromId?: string,
  ): Promise<{ id: string; code: string }> => {
    const firstSeen = cluster.alerts.reduce(
      (min, a) => (a.firstSeen < min ? a.firstSeen : min),
      cluster.alerts[0]!.firstSeen,
    );
    const lastSeen = cluster.alerts.reduce(
      (max, a) => (a.lastSeen > max ? a.lastSeen : max),
      cluster.alerts[0]!.lastSeen,
    );
    const fingerprintIds = cluster.alerts.map((a) => a.fingerprintId);
    // 复发事件把旧事件 id 混进 key：文档公式的纯指纹集合在"同一故障第二次发生"时会撞唯一键
    const clusterKey = reopenedFromId
      ? clusterKeyOf([...fingerprintIds, `reopen:${reopenedFromId}`])
      : clusterKeyOf(fingerprintIds);

    let code = await nextIncidentCode(firstSeen);
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const created = await db.incident.create({
          data: {
            code,
            title: buildIncidentTitle(cluster.alerts),
            status: 'OPEN',
            severity: maxSeverity(cluster.alerts.map((a) => a.severity)),
            startedAt: firstSeen,
            lastSeen,
            clusterKey,
            reopenedFromId: reopenedFromId ?? null,
          },
          select: { id: true, code: true },
        });
        await attachAlerts(created.id, cluster.alerts);
        return created;
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        // clusterKey 撞了（同簇已被别的事件占用）→ 直接并入已存在的那个
        const sameKey = await db.incident.findUnique({
          where: { clusterKey },
          select: { id: true, code: true },
        });
        if (sameKey) {
          await attachAlerts(sameKey.id, cluster.alerts);
          return sameKey;
        }
        // 否则是当天编码撞了，重算一次
        code = await nextIncidentCode(new Date(now.getTime() + attempt + 1));
      }
    }
    throw new Error('事件编码连续冲突，聚合中止');
  };

  const resolveCluster = async (cluster: AlertCluster): Promise<void> => {
    const matches = rankIncidents(cluster, active, graph, now);
    const best = bestIncidentAboveThreshold(matches);

    // B2：两个候选分差 < 0.05 时直接合并，避免同一故障被拆成两个事件
    const second = matches[1];
    if (
      best &&
      second &&
      second.score >= CLUSTER_THRESHOLD &&
      best.score - second.score < SCORE_TIE_EPSILON
    ) {
      const check = checkMergeable(
        toMergeCandidate(best.incident),
        toMergeCandidate(second.incident),
        graph,
      );
      if (check.ok) {
        const merged = await mergeIncidents(best.incident.id, second.incident.id, now);
        if (merged) {
          summary.merged.push({
            from: merged.mergedCode,
            into: merged.keeperCode,
            movedAlerts: merged.movedAlerts,
          });
          active = active.filter((i) => i.id !== merged.mergedId);
        }
      }
    }

    // B5：跨窗口延续。同一设备簇在事件最近上报后 30 分钟内再现 → 直接沿用。
    // 打分的时间项以 firstSeen 为锚，静默超过 5 分钟就归零，只靠分数会把一场持续故障拆成两个事件。
    const continuation = findContinuation(cluster, active, graph, now);
    if (continuation) {
      await attachAlerts(continuation.id, cluster.alerts);
      await refreshIncidentAggregate(continuation.id);
      summary.updated.push({
        id: continuation.id,
        code: continuation.code,
        added: cluster.alerts.length,
      });
      touchActive(continuation, cluster.alerts);
      return;
    }

    if (best) {
      await attachAlerts(best.incident.id, cluster.alerts);
      await refreshIncidentAggregate(best.incident.id);
      summary.updated.push({
        id: best.incident.id,
        code: best.incident.code,
        added: cluster.alerts.length,
      });
      touchActive(best.incident, cluster.alerts);
      return;
    }

    // 不足 3 条不成事件（防噪声）；它们仍留在库里，后续告警可以把簇补够
    if (cluster.alerts.length < MIN_ALERTS_PER_INCIDENT) {
      summary.noiseAlerts += cluster.alerts.length;
      return;
    }

    // B6：30 分钟内同簇再现 → 重开原事件
    const recent = closed.find((c) => c.kind === 'recent' && matchesFault(cluster, c.incident));
    if (recent) {
      const reopenedCount = await reopenIncident(recent.incident.id, now);
      await attachAlerts(recent.incident.id, cluster.alerts);
      await refreshIncidentAggregate(recent.incident.id);
      summary.reopened.push({
        id: recent.incident.id,
        code: recent.incident.code,
        reopenedCount,
      });
      touchActive(recent.incident, cluster.alerts);
      return;
    }

    // B8：clusterKey 命中 → 复用（重跑同一批数据必须落到同一个事件）
    const clusterKey = clusterKeyOf(cluster.alerts.map((a) => a.fingerprintId));
    const byKey = await db.incident.findUnique({
      where: { clusterKey },
      select: { id: true, code: true, status: true },
    });
    if (byKey) {
      if (isClosedStatus(byKey.status)) {
        const reopenedCount = await reopenIncident(byKey.id, now);
        summary.reopened.push({ id: byKey.id, code: byKey.code, reopenedCount });
      } else {
        summary.updated.push({ id: byKey.id, code: byKey.code, added: cluster.alerts.length });
      }
      await attachAlerts(byKey.id, cluster.alerts);
      await refreshIncidentAggregate(byKey.id);
      return;
    }

    // 超过 30 分钟的同簇历史 → 新建事件并指回旧事件（B6 后半段）
    const older = closed.find((c) => c.kind === 'older' && matchesFault(cluster, c.incident));
    const created = await createIncident(cluster, older?.incident.id);
    summary.created.push({
      id: created.id,
      code: created.code,
      alerts: cluster.alerts.length,
    });
    touchActive(
      {
        id: created.id,
        code: created.code,
        status: 'OPEN' as IncidentStatus,
        startedAt: cluster.alerts[0]!.firstSeen,
        lastSeen: cluster.alerts[0]!.lastSeen,
        deviceIds: cluster.deviceIds,
        alerts: [],
      },
      cluster.alerts,
    );
  };

  for (const cluster of clusters) {
    await resolveCluster(cluster);
  }

  // B3 / B7：事件级合并单独一遍（跨 run 产生的重复事件靠这里收口）
  for (let round = 0; round < 5; round++) {
    const rows = await db.incident.findMany({
      where: { status: { in: [...ACTIVE_INCIDENT_STATUSES] } },
      orderBy: [{ code: 'asc' }],
      select: INCIDENT_SELECT,
    });
    const list = rows.map(toLoadedIncident);
    let mergedThisRound = 0;

    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i]!;
        const b = list[j]!;
        const check = checkMergeable(toMergeCandidate(a), toMergeCandidate(b), graph);
        if (!check.ok) continue;
        const merged = await mergeIncidents(a.id, b.id, now);
        if (merged) {
          summary.merged.push({
            from: merged.mergedCode,
            into: merged.keeperCode,
            movedAlerts: merged.movedAlerts,
          });
          mergedThisRound++;
        }
      }
    }
    if (mergedThisRound === 0) break;
  }

  summary.durationMs = Date.now() - startedAtMs;
  return summary;
}

/** 供剧本接口回填 incidentId：取这些告警当前归属的事件 */
export async function incidentsOfAlerts(alertIds: readonly string[]): Promise<string[]> {
  if (alertIds.length === 0) return [];
  const rows = await db.alert.findMany({
    where: { id: { in: [...alertIds] }, incidentId: { not: null } },
    select: { incidentId: true },
  });
  return [...new Set(rows.map((r) => r.incidentId).filter((id): id is string => !!id))];
}
