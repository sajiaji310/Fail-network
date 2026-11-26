import type { IncidentStatus, Severity } from '@prisma/client';
import { db } from '@/lib/db';
import type { ClusterAlert } from './cluster';

const SEVERITY_RANK: Record<Severity, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

export function maxSeverity(severities: readonly Severity[]): Severity {
  let best: Severity = 'P3';
  let bestRank = SEVERITY_RANK.P3;
  for (const s of severities) {
    const rank = SEVERITY_RANK[s];
    if (rank < bestRank) {
      best = s;
      bestRank = rank;
    }
  }
  return best;
}

export function isClosedStatus(status: IncidentStatus): boolean {
  return status === 'RESOLVED' || status === 'CLOSED';
}

/**
 * `INC-YYYYMMDD-NNN` 按租户、按天递增。
 *
 * 取该租户当天已有编码的最大序号 +1，而不是 count+1 —— 事件被删过之后 count 会回退，
 * 导致编码重复撞唯一键。日期用东八区（UTC+8），与 seed 的编码规则保持一致。
 * 不同租户同一天可以各有一条 `INC-YYYYMMDD-001`。
 */
export async function nextIncidentCode(at: Date, tenantId = 'default'): Promise<string> {
  const day = new Date(at.getTime() + 8 * 3600_000).toISOString().slice(0, 10).replace(/-/g, '');
  const prefix = `INC-${day}-`;
  const rows = await db.incident.findMany({
    where: { tenantId, code: { startsWith: prefix } },
    select: { code: true },
  });
  let max = 0;
  for (const row of rows) {
    const seq = Number.parseInt(row.code.slice(prefix.length), 10);
    if (Number.isFinite(seq) && seq > max) max = seq;
  }
  return `${prefix}${String(max + 1).padStart(3, '0')}`;
}

export type IncidentAggregate = {
  severity: Severity;
  startedAt: Date;
  lastSeen: Date;
  alertCount: number;
};

/** 用事件内的有效告警（不含 SUPPRESSED）重算聚合字段 */
export async function computeAggregate(incidentId: string): Promise<IncidentAggregate | null> {
  const rows = await db.alert.findMany({
    where: { incidentId, status: { not: 'SUPPRESSED' } },
    select: { severity: true, firstSeen: true, lastSeen: true },
  });
  if (rows.length === 0) return null;

  let startedAt = rows[0]!.firstSeen;
  let lastSeen = rows[0]!.lastSeen;
  for (const r of rows) {
    if (r.firstSeen < startedAt) startedAt = r.firstSeen;
    if (r.lastSeen > lastSeen) lastSeen = r.lastSeen;
  }
  return {
    severity: maxSeverity(rows.map((r) => r.severity)),
    startedAt,
    lastSeen,
    alertCount: rows.length,
  };
}

export async function refreshIncidentAggregate(
  incidentId: string,
): Promise<IncidentAggregate | null> {
  const aggregate = await computeAggregate(incidentId);
  if (!aggregate) return null;
  await db.incident.update({
    where: { id: incidentId },
    data: {
      severity: aggregate.severity,
      startedAt: aggregate.startedAt,
      lastSeen: aggregate.lastSeen,
    },
  });
  return aggregate;
}

/** 把告警挂到事件上（单归属：一条告警只会有一个 incidentId） */
export async function attachAlerts(
  incidentId: string,
  alerts: readonly ClusterAlert[],
): Promise<void> {
  if (alerts.length === 0) return;
  await db.alert.updateMany({
    where: { id: { in: alerts.map((a) => a.id) } },
    data: { incidentId },
  });
}

/**
 * 事件标题：主设备 + 首要告警类型。
 * 主设备取"最严重告警所在设备"，同严重度取时间最早 —— 确定性，不依赖数组顺序。
 */
export function buildIncidentTitle(alerts: readonly ClusterAlert[]): string {
  const ordered = [...alerts].sort((a, b) => {
    const rank = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (rank !== 0) return rank;
    return a.firstSeen.getTime() - b.firstSeen.getTime();
  });
  const primary = ordered[0];
  if (!primary) return '未命名事件';
  const deviceCount = new Set(alerts.map((a) => a.deviceId)).size;
  return deviceCount > 1
    ? `${primary.deviceName} ${primary.type}（波及 ${deviceCount} 台设备）`
    : `${primary.deviceName} ${primary.type}`;
}

export async function reopenIncident(incidentId: string, now: Date): Promise<number> {
  const updated = await db.incident.update({
    where: { id: incidentId },
    data: {
      status: 'OPEN',
      resolvedAt: null,
      mttrSeconds: null,
      closedReason: null,
      lastSeen: now,
      reopenedCount: { increment: 1 },
    },
    select: { reopenedCount: true },
  });
  return updated.reopenedCount;
}
