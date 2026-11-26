import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { isSuppressible, PARENT_ALERT_TYPES } from './taxonomy';

/** B9 回溯窗口：父告警到达后回看 2 小时 */
export const SUPPRESSION_LOOKBACK_MS = 2 * 60 * 60 * 1000;

/** 事件成立的最小告警数（第 4.1 节：簇内 ≥ 3 条才成事件） */
export const MIN_ALERTS_PER_INCIDENT = 3;

export type SuppressedIncidentImpact = {
  incidentId: string;
  /** 撤出被抑制告警后，事件里还剩多少条有效告警 */
  remaining: number;
  closed: boolean;
};

export type SuppressOutcome = {
  suppressedAlertIds: string[];
  affectedIncidents: SuppressedIncidentImpact[];
};

/** 该设备当前是否有活跃的父告警（设备离线类），有则其下所有子告警都应被压制 */
export async function findActiveParent(
  deviceId: string,
  client: Prisma.TransactionClient | typeof db = db,
  excludeIds?: ReadonlySet<string>,
): Promise<{ id: string; firstSeen: Date } | null> {
  const row = await client.alert.findFirst({
    where: {
      status: 'ACTIVE',
      fingerprint: { deviceId, type: { in: [...PARENT_ALERT_TYPES] } },
      ...(excludeIds && excludeIds.size > 0 ? { id: { notIn: [...excludeIds] } } : {}),
    },
    orderBy: { lastSeen: 'desc' },
    select: { id: true, firstSeen: true },
  });
  return row;
}

type ParentAlert = {
  id: string;
  firstSeen: Date;
  lastSeen: Date;
  deviceId: string;
};

async function loadParent(
  parentAlertId: string,
  client: Prisma.TransactionClient | typeof db,
): Promise<ParentAlert | null> {
  const row = await client.alert.findUnique({
    where: { id: parentAlertId },
    select: {
      id: true,
      firstSeen: true,
      lastSeen: true,
      fingerprint: { select: { deviceId: true } },
    },
  });
  if (!row) return null;
  return {
    id: row.id,
    firstSeen: row.firstSeen,
    lastSeen: row.lastSeen,
    deviceId: row.fingerprint.deviceId,
  };
}

/**
 * B9 父告警晚到回溯：
 * 父告警落库后，把它回溯窗口内同设备、可抑制、仍 ACTIVE 的子告警置为 SUPPRESSED，
 * 并从已归属的事件中撤出；事件剩余告警 < 3 条时自动关闭（closedReason=AUTO_CLOSED）。
 *
 * 幂等：重复调用只会命中仍 ACTIVE 的行，已 SUPPRESSED / RESOLVED 的不再变动。
 */
export async function suppressByParent(
  parentAlertId: string,
  now: Date = new Date(),
  /** 同一次导入里尚未“到达”的告警。父告警不能提前压到它们，否则回溯计数会把后到的子告警算进去。 */
  excludeIds?: ReadonlySet<string>,
): Promise<SuppressOutcome> {
  return db.$transaction(
    async (tx) => {
      const parent = await loadParent(parentAlertId, tx);
      if (!parent) return { suppressedAlertIds: [], affectedIncidents: [] };

      const windowStart = new Date(parent.firstSeen.getTime() - SUPPRESSION_LOOKBACK_MS);

      const candidates = await tx.alert.findMany({
        where: {
          status: 'ACTIVE',
          fingerprint: { deviceId: parent.deviceId },
          // 窗口只设下界：父告警 ACTIVE 意味着设备此刻仍不可达，
          // 之后补报的子告警同样应被追溯压制（上游重传常见）
          lastSeen: { gte: windowStart },
          id: { not: parent.id },
        },
        select: { id: true, fingerprint: { select: { type: true } }, incidentId: true },
      });

      const targets = candidates.filter(
        (c) => isSuppressible(c.fingerprint.type) && !excludeIds?.has(c.id),
      );
      if (targets.length === 0) return { suppressedAlertIds: [], affectedIncidents: [] };

      const ids = targets.map((t) => t.id);
      await tx.alert.updateMany({
        where: { id: { in: ids }, status: 'ACTIVE' },
        data: { status: 'SUPPRESSED', suppressedByAlertId: parent.id },
      });

      const incidentIds = [
        ...new Set(
          targets.map((t) => t.incidentId).filter((id): id is string => typeof id === 'string'),
        ),
      ];
      const affectedIncidents: SuppressedIncidentImpact[] = [];

      for (const incidentId of incidentIds) {
        const remaining = await tx.alert.count({
          where: { incidentId, status: { not: 'SUPPRESSED' } },
        });
        let closed = false;

        if (remaining < MIN_ALERTS_PER_INCIDENT) {
          const incident = await tx.incident.findUnique({
            where: { id: incidentId },
            select: { id: true, status: true, startedAt: true },
          });
          if (incident && incident.status !== 'RESOLVED' && incident.status !== 'CLOSED') {
            const resolvedAt = now;
            await tx.incident.update({
              where: { id: incidentId },
              data: {
                status: 'CLOSED',
                closedReason: 'AUTO_CLOSED',
                resolvedAt,
                mttrSeconds: Math.max(
                  0,
                  Math.round((resolvedAt.getTime() - incident.startedAt.getTime()) / 1000),
                ),
              },
            });
            closed = true;
          }
        }

        affectedIncidents.push({ incidentId, remaining, closed });
      }

      return { suppressedAlertIds: ids, affectedIncidents };
    },
    { timeout: 15_000 },
  );
}

/**
 * 4.3「SUPPRESSED ──(父恢复)──► ACTIVE」：
 * 父告警恢复后，按溯源字段精确恢复它压制过的子告警，不误伤别的父告警压制的行。
 */
export async function restoreByParent(parentAlertId: string): Promise<string[]> {
  const rows = await db.alert.findMany({
    where: { suppressedByAlertId: parentAlertId, status: 'SUPPRESSED' },
    select: { id: true },
  });
  if (rows.length === 0) return [];

  await db.alert.updateMany({
    where: { id: { in: rows.map((r) => r.id) }, status: 'SUPPRESSED' },
    data: { status: 'ACTIVE', suppressedByAlertId: null },
  });
  return rows.map((r) => r.id);
}

/** 父告警恢复：置 RESOLVED + 回滚它压制的子告警 */
export async function resolveParentAlert(parentAlertId: string): Promise<{
  restored: string[];
}> {
  await db.alert.updateMany({
    where: { id: parentAlertId, status: { in: ['ACTIVE', 'SUPPRESSED'] } },
    data: { status: 'RESOLVED' },
  });
  const restored = await restoreByParent(parentAlertId);
  return { restored };
}
