import { db } from '@/lib/db';

/**
 * 运行指标（评审第 4 阶段「在真实事件上测量 MTTR、人工接受率和误抑制成本」）。
 *
 * 三个指标都从现有业务表算，不额外埋点：
 * - **MTTR**：已结案事件的 `mttrSeconds`。取 p50/p90 而不是平均值 —— 一次跨夜故障
 *   就能把平均值拉成谣言，中位数才代表"多数情况"。
 * - **人工接受率**：已裁决假设里 ACCEPTED 的占比。分母是"人真的点了按钮的假设"，
 *   不是全部假设：没裁决等于没人看，算进分母会把接受率稀释成"没人用"。
 * - **误抑制成本**：被压制的告警里，**父告警先恢复、它自己还在报**的那部分。
 *   父告警恢复了压制理由就消失了，此时仍处于 SUPPRESSED 说明压错了对象
 *   （或者回滚没跑），这类告警会推迟值班人发现独立故障的时间，成本就是它。
 *
 * 口径写在这里而不是散在页面里：指标一旦有第二种算法，"多少才算好"就没法讨论了。
 */

export type OpsWindow = { from: Date; to: Date; days: number };

export function defaultWindow(days = 30, now = new Date()): OpsWindow {
  return { from: new Date(now.getTime() - days * 24 * 3600_000), to: now, days };
}

export type OpsMetrics = {
  window: { days: number; from: string; to: string };
  incidents: {
    created: number;
    closed: number;
    /** 已结案事件的 MTTR（秒） */
    mttrSeconds: { p50: number | null; p90: number | null; avg: number | null; samples: number };
    reopened: number;
  };
  acceptance: {
    decided: number;
    accepted: number;
    rejected: number;
    /** 0–1；decided=0 时为 null（不是 0，0 会被误读成"没人采纳"） */
    rate: number | null;
  };
  suppression: {
    suppressed: number;
    /** 父告警已恢复但自身仍在抑制状态 */
    wrong: number;
    /** 0–1；suppressed=0 时为 null */
    rate: number | null;
    affectedIncidents: number;
  };
  dataSources: {
    batches: number;
    byKind: { kind: string; batches: number; accepted: number; failed: number }[];
    /** 来自真实适配器（externalKey 前缀 am:/zbx:）的告警数 */
    realAlerts: number;
    simulatedAlerts: number;
    metricSamples: number;
  };
};

export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? null;
}

export async function getOpsMetrics(
  window = defaultWindow(),
  tenantId = 'default',
): Promise<OpsMetrics> {
  const { from, to } = window;
  const incidentScope = { tenantId, startedAt: { gte: from, lte: to } };

  const [created, closedRows, reopened, verdictRows] = await Promise.all([
    db.incident.count({ where: incidentScope }),
    db.incident.findMany({
      where: {
        tenantId,
        status: 'CLOSED',
        resolvedAt: { gte: from, lte: to },
        mttrSeconds: { not: null },
      },
      select: { mttrSeconds: true },
    }),
    db.incident.count({ where: { ...incidentScope, reopenedCount: { gt: 0 } } }),
    db.hypothesis.groupBy({
      by: ['verdict'],
      where: {
        verdict: { not: null },
        createdAt: { gte: from, lte: to },
        incident: { tenantId },
      },
      _count: { _all: true },
    }),
  ]);

  const mttrValues = closedRows
    .map((row) => row.mttrSeconds)
    .filter((value): value is number => value !== null);
  const avg =
    mttrValues.length === 0
      ? null
      : Math.round(mttrValues.reduce((sum, v) => sum + v, 0) / mttrValues.length);

  const decided = verdictRows.reduce((sum, row) => sum + row._count._all, 0);
  const accepted = verdictRows.find((row) => row.verdict === 'ACCEPTED')?._count._all ?? 0;
  const rejected = verdictRows.find((row) => row.verdict === 'REJECTED')?._count._all ?? 0;

  const suppressedAlerts = await db.alert.findMany({
    where: { tenantId, status: 'SUPPRESSED', suppressedByAlertId: { not: null } },
    select: {
      id: true,
      lastSeen: true,
      incidentId: true,
      suppressedBy: { select: { lastSeen: true, status: true } },
    },
  });
  const wrong = suppressedAlerts.filter(
    (alert) =>
      alert.suppressedBy !== null &&
      alert.suppressedBy.status !== 'ACTIVE' &&
      alert.suppressedBy.lastSeen.getTime() < alert.lastSeen.getTime(),
  );

  const [batches, batchGroups, realAlerts, simulatedAlerts, metricSamples] = await Promise.all([
    db.ingestBatch.count({ where: { tenantId, createdAt: { gte: from, lte: to } } }),
    db.ingestBatch.groupBy({
      by: ['kind'],
      where: { tenantId, createdAt: { gte: from, lte: to } },
      _count: { _all: true },
      _sum: { accepted: true, failed: true },
    }),
    db.alert.count({
      where: {
        tenantId,
        firstSeen: { gte: from, lte: to },
        OR: [{ externalKey: { startsWith: 'am:' } }, { externalKey: { startsWith: 'zbx:' } }],
      },
    }),
    db.alert.count({
      where: {
        tenantId,
        firstSeen: { gte: from, lte: to },
        NOT: {
          OR: [{ externalKey: { startsWith: 'am:' } }, { externalKey: { startsWith: 'zbx:' } }],
        },
      },
    }),
    db.metricSample.count({ where: { tenantId, at: { gte: from, lte: to } } }),
  ]);

  return {
    window: { days: window.days, from: from.toISOString(), to: to.toISOString() },
    incidents: {
      created,
      closed: closedRows.length,
      mttrSeconds: {
        p50: percentile(mttrValues, 50),
        p90: percentile(mttrValues, 90),
        avg,
        samples: mttrValues.length,
      },
      reopened,
    },
    acceptance: {
      decided,
      accepted,
      rejected,
      rate: decided === 0 ? null : Math.round((accepted / decided) * 1000) / 1000,
    },
    suppression: {
      suppressed: suppressedAlerts.length,
      wrong: wrong.length,
      rate:
        suppressedAlerts.length === 0
          ? null
          : Math.round((wrong.length / suppressedAlerts.length) * 1000) / 1000,
      affectedIncidents: new Set(
        wrong.map((alert) => alert.incidentId).filter((id): id is string => !!id),
      ).size,
    },
    dataSources: {
      batches,
      byKind: batchGroups
        .map((group) => ({
          kind: group.kind,
          batches: group._count._all,
          accepted: group._sum.accepted ?? 0,
          failed: group._sum.failed ?? 0,
        }))
        .sort((a, b) => b.batches - a.batches),
      realAlerts,
      simulatedAlerts,
      metricSamples,
    },
  };
}
