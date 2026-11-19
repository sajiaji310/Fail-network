import type { AlertStatus, Prisma, Severity } from '@prisma/client';
import { db } from '@/lib/db';
import { signatureOf } from './fingerprint';
import { normalizeOccurrence, type CycleAction } from './normalize';
import { findActiveParent, suppressByParent } from './suppress';
import { classifyAlertType } from './taxonomy';

export type ParentCache = Map<string, { id: string; firstSeen: Date } | null>;

export type RecordAlertInput = {
  deviceId: string;
  type: string;
  severity: Severity;
  metric?: string | null;
  value?: number | null;
  threshold?: number | null;
  message: string;
  count?: number;
  firstSeen: Date;
  lastSeen?: Date;
  externalKey?: string | null;
  source: string;
  raw?: Record<string, unknown>;
  /** 批量导入时复用，避免每条子告警都查一次父告警 */
  parentCache?: ParentCache;
};

export type RecordOutcome = {
  alertId: string;
  action: CycleAction;
  status: AlertStatus;
  /** 本条是否落到 SUPPRESSED（AC-02） */
  suppressed: boolean;
  /** 本条是父告警时，回溯压制掉的历史告警数（B9） */
  retroSuppressed: number;
  /** 本次触发的自动关闭事件数（B9） */
  autoClosedIncidents: number;
};

/**
 * T04 主链路：指纹 → 周期归一化 → 抑制。
 * 调用方只需给出"一条原始告警"，不必关心 30 分钟规则与父告警关系。
 */
export async function recordAlert(
  input: RecordAlertInput,
  now: Date = new Date(),
): Promise<RecordOutcome> {
  const signature = signatureOf(input.deviceId, input.type, input.metric);
  const fingerprint = await db.alertFingerprint.upsert({
    where: { signature },
    create: {
      signature,
      deviceId: input.deviceId,
      type: input.type,
      metric: input.metric ?? null,
      severity: input.severity,
    },
    update: { severity: input.severity },
  });

  const normalized = await normalizeOccurrence({
    fingerprintId: fingerprint.id,
    severity: input.severity,
    value: input.value ?? null,
    threshold: input.threshold ?? null,
    message: input.message,
    count: input.count,
    firstSeen: input.firstSeen,
    lastSeen: input.lastSeen,
    externalKey: input.externalKey ?? null,
    raw: { source: input.source, ...(input.raw ?? {}) } as Prisma.InputJsonValue,
  });

  const kind = classifyAlertType(input.type);

  if (kind === 'PARENT') {
    // B9：父告警一到，立刻回溯压掉窗口内的子告警（不管子告警是否先到）
    const outcome = await suppressByParent(normalized.alertId, now);
    input.parentCache?.set(input.deviceId, {
      id: normalized.alertId,
      firstSeen: input.firstSeen,
    });
    return {
      alertId: normalized.alertId,
      action: normalized.action,
      status: normalized.status,
      suppressed: false,
      retroSuppressed: outcome.suppressedAlertIds.length,
      autoClosedIncidents: outcome.affectedIncidents.filter((i) => i.closed).length,
    };
  }

  // 子告警：设备已有活跃父告警则直接落 SUPPRESSED（父先到的方向）
  // 累加到既有周期时不改状态 —— 那条行的状态在父告警到达时已被统一处理
  if (kind === 'CHILD' && normalized.action !== 'ACCUMULATED') {
    const parent =
      input.parentCache?.get(input.deviceId) ?? (await findActiveParent(input.deviceId, db));
    if (input.parentCache && !input.parentCache.has(input.deviceId)) {
      input.parentCache.set(input.deviceId, parent);
    }
    if (parent) {
      await db.alert.update({
        where: { id: normalized.alertId },
        data: { status: 'SUPPRESSED', suppressedByAlertId: parent.id },
      });
      return {
        alertId: normalized.alertId,
        action: normalized.action,
        status: 'SUPPRESSED',
        suppressed: true,
        retroSuppressed: 0,
        autoClosedIncidents: 0,
      };
    }
  }

  return {
    alertId: normalized.alertId,
    action: normalized.action,
    status: normalized.status,
    suppressed: normalized.status === 'SUPPRESSED',
    retroSuppressed: 0,
    autoClosedIncidents: 0,
  };
}

export type AlertStats = {
  total: number;
  active: number;
  suppressed: number;
  resolved: number;
  /** 同一周期内重复上报的累计次数（sum(count) - total） */
  collapsed: number;
  suppressedByType: Array<{ type: string; count: number }>;
};

export async function getAlertStats(): Promise<AlertStats> {
  const [total, active, suppressed, resolved, agg, grouped] = await Promise.all([
    db.alert.count(),
    db.alert.count({ where: { status: 'ACTIVE' } }),
    db.alert.count({ where: { status: 'SUPPRESSED' } }),
    db.alert.count({ where: { status: 'RESOLVED' } }),
    db.alert.aggregate({ _sum: { count: true } }),
    db.alert.groupBy({
      by: ['fingerprintId'],
      where: { status: 'SUPPRESSED' },
      _count: { _all: true },
    }),
  ]);

  let suppressedByType: Array<{ type: string; count: number }> = [];
  if (grouped.length > 0) {
    const fingerprints = await db.alertFingerprint.findMany({
      where: { id: { in: grouped.map((g) => g.fingerprintId) } },
      select: { id: true, type: true },
    });
    const typeById = new Map(fingerprints.map((f) => [f.id, f.type]));
    const byType = new Map<string, number>();
    for (const g of grouped) {
      const type = typeById.get(g.fingerprintId) ?? 'UNKNOWN';
      byType.set(type, (byType.get(type) ?? 0) + g._count._all);
    }
    suppressedByType = [...byType.entries()]
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count);
  }

  return {
    total,
    active,
    suppressed,
    resolved,
    collapsed: Math.max(0, (agg._sum.count ?? 0) - total),
    suppressedByType,
  };
}

export type AlertListQuery = {
  status?: AlertStatus[];
  severity?: Severity[];
  deviceId?: string;
  type?: string;
  from?: Date;
  to?: Date;
  page: number;
  pageSize: number;
};

export type AlertListItem = {
  id: string;
  deviceId: string;
  deviceName: string;
  type: string;
  metric: string | null;
  severity: Severity;
  status: AlertStatus;
  message: string;
  count: number;
  firstSeen: Date;
  lastSeen: Date;
  incidentId: string | null;
  suppressedByAlertId: string | null;
};

export type AlertListResult = {
  items: AlertListItem[];
  total: number;
  page: number;
  pageSize: number;
};

/** `GET /api/v1/alerts` 的查询实现（文档 11 节第 8 条） */
export async function listAlerts(query: AlertListQuery): Promise<AlertListResult> {
  const fingerprintFilter: Prisma.AlertFingerprintWhereInput = {};
  if (query.deviceId) fingerprintFilter.deviceId = query.deviceId;
  if (query.type) fingerprintFilter.type = query.type;

  const where: Prisma.AlertWhereInput = {
    ...(query.status?.length ? { status: { in: query.status } } : {}),
    ...(query.severity?.length ? { severity: { in: query.severity } } : {}),
    ...(Object.keys(fingerprintFilter).length ? { fingerprint: fingerprintFilter } : {}),
    ...(query.from || query.to
      ? {
          lastSeen: {
            ...(query.from ? { gte: query.from } : {}),
            ...(query.to ? { lte: query.to } : {}),
          },
        }
      : {}),
  };

  const [total, rows] = await Promise.all([
    db.alert.count({ where }),
    db.alert.findMany({
      where,
      orderBy: [{ lastSeen: 'desc' }, { id: 'desc' }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      select: {
        id: true,
        severity: true,
        status: true,
        message: true,
        count: true,
        firstSeen: true,
        lastSeen: true,
        incidentId: true,
        suppressedByAlertId: true,
        fingerprint: {
          select: {
            type: true,
            metric: true,
            deviceId: true,
            device: { select: { name: true } },
          },
        },
      },
    }),
  ]);

  return {
    total,
    page: query.page,
    pageSize: query.pageSize,
    items: rows.map((r) => ({
      id: r.id,
      deviceId: r.fingerprint.deviceId,
      deviceName: r.fingerprint.device.name,
      type: r.fingerprint.type,
      metric: r.fingerprint.metric,
      severity: r.severity,
      status: r.status,
      message: r.message,
      count: r.count,
      firstSeen: r.firstSeen,
      lastSeen: r.lastSeen,
      incidentId: r.incidentId,
      suppressedByAlertId: r.suppressedByAlertId,
    })),
  };
}
