import { db } from '@/lib/db';

/**
 * 数据保留策略（评审第 4 阶段「数据保留策略」）。
 *
 * 清理顺序与默认值都是按"删了以后还能不能回答运维问题"定的：
 * - **指标采样（30 天）**：只是辅助证据，过期即失去时效价值；
 * - **导入批次（30 天）**：排障用，过期只留计数意义；
 * - **审计（180 天）**：追责与复盘需要长一些，但也不是永久；
 * - **已结案事件（默认 0 = 不删）**：事件是 MTTR、接受率、误抑制率的唯一事实源，
 *   删掉指标就断档了。真要控体量，正确做法是归档到冷存储，而不是在本库里删。
 *   需要清理的部署可以把 `RETENTION_CLOSED_INCIDENT_DAYS` 设成正数，接口会明确告诉删了什么。
 *
 * 所有操作支持 dryRun：先看一眼数量再决定删不删，比删完发现删多了强。
 */

export type RetentionPolicy = {
  metricDays: number;
  auditDays: number;
  batchDays: number;
  /** 0 = 不清理已结案事件 */
  closedIncidentDays: number;
};

function envDays(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : fallback;
}

export function getRetentionPolicy(): RetentionPolicy {
  return {
    metricDays: envDays('RETENTION_METRIC_DAYS', 30),
    auditDays: envDays('RETENTION_AUDIT_DAYS', 180),
    batchDays: envDays('RETENTION_BATCH_DAYS', 30),
    closedIncidentDays: envDays('RETENTION_CLOSED_INCIDENT_DAYS', 0),
  };
}

export type RetentionReport = {
  dryRun: boolean;
  policy: RetentionPolicy;
  cutoffs: Record<'metrics' | 'audit' | 'batches' | 'incidents', string | null>;
  deleted: { metrics: number; audit: number; batches: number; incidents: number };
};

function cutoffOf(now: Date, days: number): Date | null {
  if (days <= 0) return null;
  return new Date(now.getTime() - days * 24 * 3600_000);
}

export async function runRetention(
  options: { dryRun?: boolean; now?: Date; policy?: RetentionPolicy; tenantId?: string } = {},
): Promise<RetentionReport> {
  const dryRun = options.dryRun ?? true;
  const now = options.now ?? new Date();
  const policy = options.policy ?? getRetentionPolicy();
  const tenantId = options.tenantId ?? 'default';

  const metricCutoff = cutoffOf(now, policy.metricDays);
  const auditCutoff = cutoffOf(now, policy.auditDays);
  const batchCutoff = cutoffOf(now, policy.batchDays);
  const incidentCutoff = cutoffOf(now, policy.closedIncidentDays);

  const report: RetentionReport = {
    dryRun,
    policy,
    cutoffs: {
      metrics: metricCutoff?.toISOString() ?? null,
      audit: auditCutoff?.toISOString() ?? null,
      batches: batchCutoff?.toISOString() ?? null,
      incidents: incidentCutoff?.toISOString() ?? null,
    },
    deleted: { metrics: 0, audit: 0, batches: 0, incidents: 0 },
  };

  if (metricCutoff) {
    if (dryRun) {
      report.deleted.metrics = await db.metricSample.count({
        where: { tenantId, at: { lt: metricCutoff } },
      });
    } else {
      report.deleted.metrics = (
        await db.metricSample.deleteMany({ where: { tenantId, at: { lt: metricCutoff } } })
      ).count;
    }
  }

  if (auditCutoff) {
    if (dryRun) {
      report.deleted.audit = await db.auditLog.count({
        where: { tenantId, at: { lt: auditCutoff } },
      });
    } else {
      report.deleted.audit = (
        await db.auditLog.deleteMany({ where: { tenantId, at: { lt: auditCutoff } } })
      ).count;
    }
  }

  if (batchCutoff) {
    const where = {
      tenantId,
      createdAt: { lt: batchCutoff },
      // 跑着的批次不删：进度条还在用这一行
      status: { in: ['DONE' as const, 'FAILED' as const] },
    };
    if (dryRun) {
      report.deleted.batches = await db.ingestBatch.count({ where });
    } else {
      report.deleted.batches = (await db.ingestBatch.deleteMany({ where })).count;
    }
  }

  if (incidentCutoff) {
    const where = {
      tenantId,
      status: 'CLOSED' as const,
      resolvedAt: { lt: incidentCutoff },
    };
    if (dryRun) {
      report.deleted.incidents = await db.incident.count({ where });
    } else {
      report.deleted.incidents = (await db.incident.deleteMany({ where })).count;
    }
  }

  return report;
}
