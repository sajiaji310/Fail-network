import { db } from '@/lib/db';
import { maxSeverity } from './persist';
import {
  CLOSED_INCIDENT_STATUSES,
  MAX_HOPS,
  MERGE_MIN_SHARED_DEVICES,
  MERGE_OVERLAP_RATIO,
} from './constants';
import type { DeviceGraph } from './topology';
import type { Severity } from '@prisma/client';

/**
 * B3 事件合并 + B7 强制不合并。
 * 合并是"两个已存在的事件"之间的动作（跨 run 才会出现），
 * 与簇内并查集是两条独立路径 —— 簇内合并靠打分，事件合并靠共享设备与时间重叠。
 */

export type MergeCandidate = {
  id: string;
  code: string;
  startedAt: Date;
  lastSeen: Date;
  deviceIds: readonly string[];
};

export type MergeCheck = {
  ok: boolean;
  reason?: string;
  sharedDevices: number;
  overlapRatio: number;
  hops: number;
};

/** 时间重叠比例：交集 / 并集（Jaccard），0~1 */
export function intervalOverlapRatio(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): number {
  const start = Math.max(aStart.getTime(), bStart.getTime());
  const end = Math.min(aEnd.getTime(), bEnd.getTime());
  const overlap = Math.max(0, end - start);
  const spanStart = Math.min(aStart.getTime(), bStart.getTime());
  const spanEnd = Math.max(aEnd.getTime(), bEnd.getTime());
  const union = spanEnd - spanStart;
  // 两个瞬时事件并集为 0：只要时间点相同就算完全重叠
  if (union <= 0) return overlap > 0 || aStart.getTime() === bStart.getTime() ? 1 : 0;
  return overlap / union;
}

export function checkMergeable(
  a: MergeCandidate,
  b: MergeCandidate,
  graph: DeviceGraph,
): MergeCheck {
  const shared = a.deviceIds.filter((d) => b.deviceIds.includes(d));
  const hops = graph.minHopBetween(a.deviceIds, b.deviceIds);
  const overlapRatio = intervalOverlapRatio(a.startedAt, a.lastSeen, b.startedAt, b.lastSeen);
  const base = { sharedDevices: shared.length, overlapRatio, hops };

  // B7 先判：拓扑太远直接拒绝，哪怕时间完全重叠
  if (hops > MAX_HOPS) return { ...base, ok: false, reason: 'TOPOLOGY_TOO_FAR' };
  if (shared.length < MERGE_MIN_SHARED_DEVICES) {
    return { ...base, ok: false, reason: 'SHARED_DEVICES_TOO_FEW' };
  }
  if (overlapRatio <= MERGE_OVERLAP_RATIO) {
    return { ...base, ok: false, reason: 'TIME_OVERLAP_TOO_LOW' };
  }
  return { ...base, ok: true };
}

export type MergeResult = {
  keeperId: string;
  keeperCode: string;
  mergedId: string;
  mergedCode: string;
  movedAlerts: number;
};

/**
 * B3：保留 code 较早者，被并入者置 CLOSED + mergedIntoId，告警整体迁移。
 * 幂等：重复合并同一对事件时，被并入方已 CLOSED，直接返回。
 */
export async function mergeIncidents(
  aId: string,
  bId: string,
  now: Date = new Date(),
): Promise<MergeResult | null> {
  if (aId === bId) return null;
  const [a, b] = await Promise.all([
    db.incident.findUnique({ where: { id: aId }, select: { id: true, code: true, status: true } }),
    db.incident.findUnique({ where: { id: bId }, select: { id: true, code: true, status: true } }),
  ]);
  if (!a || !b) return null;

  const closed = new Set<string>(CLOSED_INCIDENT_STATUSES);
  if (closed.has(a.status) || closed.has(b.status)) return null;

  // code 形如 INC-YYYYMMDD-NNN，字典序即时间序
  const [keeper, dropped] = a.code <= b.code ? [a, b] : [b, a];

  const moved = await db.alert.updateMany({
    where: { incidentId: dropped.id },
    data: { incidentId: keeper.id },
  });

  await db.incident.update({
    where: { id: dropped.id },
    data: {
      status: 'CLOSED',
      closedReason: 'AUTO_MERGED',
      mergedIntoId: keeper.id,
      resolvedAt: now,
    },
  });

  const rows = await db.alert.findMany({
    where: { incidentId: keeper.id, status: { not: 'SUPPRESSED' } },
    select: { severity: true, firstSeen: true, lastSeen: true },
  });
  if (rows.length > 0) {
    let startedAt = rows[0]!.firstSeen;
    let lastSeen = rows[0]!.lastSeen;
    for (const r of rows) {
      if (r.firstSeen < startedAt) startedAt = r.firstSeen;
      if (r.lastSeen > lastSeen) lastSeen = r.lastSeen;
    }
    await db.incident.update({
      where: { id: keeper.id },
      data: {
        severity: maxSeverity(rows.map((r) => r.severity as Severity)),
        startedAt,
        lastSeen,
      },
    });
  }

  return {
    keeperId: keeper.id,
    keeperCode: keeper.code,
    mergedId: dropped.id,
    mergedCode: dropped.code,
    movedAlerts: moved.count,
  };
}
