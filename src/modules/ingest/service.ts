import type { AlertStatus } from '@prisma/client';
import { db } from '@/lib/db';
import type { RecordAlertInput } from '@/modules/alerts/service';
import { recordAlerts } from '@/modules/alerts/record-batch';
import { resolveParentAlert } from '@/modules/alerts/suppress';
import { findDevice, loadDevices } from './resolve';
import type { ParseIssue, RawAlert } from './schema';

export type IngestIssue = ParseIssue & { deviceName?: string };

export type IngestOptions = {
  /** 数据归属租户。真实接入时由 API Key 携带，未指定走 default */
  tenantId?: string;
};

export type IngestResult = {
  source: string;
  /** 新落库的告警周期数（含 30 分钟到期后重开的周期） */
  accepted: number;
  /** 外部 ID 命中 或 命中 30 分钟内的同指纹周期（AC-13）→ 只累加 count / lastSeen */
  deduped: number;
  /** 本次把已有周期置为 RESOLVED 的条数（Alertmanager 恢复通知） */
  resolved: number;
  /** 本次新落库即被父告警抑制的条数（AC-02） */
  suppressed: number;
  /** 本次落库的父告警回溯压掉的历史告警数（B9） */
  retroSuppressed: number;
  /** 因 B9 撤出告警而自动关闭的事件数 */
  autoClosedIncidents: number;
  failed: number;
  issues: IngestIssue[];
};

type ExistingAlert = {
  id: string;
  status: AlertStatus;
  lastSeen: Date;
  /** 本批里已经排队、还没落库。恢复通知要等这行写完再关。 */
  pending?: boolean;
};

/**
 * 告警导入编排：设备解析 → 外部 ID 幂等 → 交给 alerts 模块做归一化与抑制。
 * 这里不实现任何生命周期/抑制规则，规则全部在 `modules/alerts/*`。
 * 恢复通知是例外：它不新建周期，只按外部键（或同设备同指标的活跃周期）关闭已有行。
 */
export async function ingestAlerts(
  source: string,
  alerts: readonly RawAlert[],
  options: IngestOptions = {},
): Promise<IngestResult> {
  const result: IngestResult = {
    source,
    accepted: 0,
    deduped: 0,
    resolved: 0,
    suppressed: 0,
    retroSuppressed: 0,
    autoClosedIncidents: 0,
    failed: 0,
    issues: [],
  };
  if (alerts.length === 0) return result;

  const tenantId = options.tenantId ?? 'default';
  const lookup = await loadDevices(tenantId);

  const externalKeys = alerts.map((a) => a.externalKey).filter((k): k is string => !!k);
  const existing = new Map<string, ExistingAlert>();
  if (externalKeys.length > 0) {
    const rows = await db.alert.findMany({
      where: { tenantId, externalKey: { in: externalKeys } },
      select: { id: true, externalKey: true, status: true, lastSeen: true },
    });
    for (const row of rows) {
      if (row.externalKey) {
        existing.set(row.externalKey, {
          id: row.id,
          status: row.status,
          lastSeen: row.lastSeen,
        });
      }
    }
  }

  const now = new Date();
  const pending: RecordAlertInput[] = [];
  const pendingByKey = new Map<string, RecordAlertInput>();
  const closeAfter = new Map<RecordAlertInput, Date | undefined>();

  const flush = async () => {
    if (pending.length === 0) return;
    const batch = pending.splice(0, pending.length);
    try {
      const outcomes = await recordAlerts(batch, now);
      for (let i = 0; i < batch.length; i++) {
        const input = batch[i]!;
        const outcome = outcomes[i]!;
        if (outcome.action === 'ACCUMULATED') result.deduped++;
        else {
          result.accepted++;
          if (outcome.suppressed) result.suppressed++;
        }
        result.retroSuppressed += outcome.retroSuppressed;
        result.autoClosedIncidents += outcome.autoClosedIncidents;

        let status = outcome.status;
        let lastSeen = input.lastSeen ?? input.firstSeen;
        if (closeAfter.has(input)) {
          const hit: ExistingAlert = { id: outcome.alertId, status, lastSeen };
          await closeExisting(hit, result, closeAfter.get(input));
          status = hit.status;
          lastSeen = hit.lastSeen;
          closeAfter.delete(input);
        }
        if (input.externalKey) {
          existing.set(input.externalKey, { id: outcome.alertId, status, lastSeen });
          pendingByKey.delete(input.externalKey);
        }
      }
    } catch (error) {
      result.failed += batch.length;
      result.issues.push({
        message: error instanceof Error ? error.message : String(error),
      });
      for (const input of batch) {
        if (input.externalKey) {
          existing.delete(input.externalKey);
          pendingByKey.delete(input.externalKey);
        }
      }
    }
  };

  for (const alert of alerts) {
    const hit = alert.externalKey ? existing.get(alert.externalKey) : undefined;

    if (alert.state === 'RESOLVED' && hit?.pending && alert.externalKey) {
      const queued = pendingByKey.get(alert.externalKey);
      if (queued) closeAfter.set(queued, alert.lastSeen);
      continue;
    }

    if (alert.state === 'RESOLVED' && hit) {
      await closeExisting(hit, result, alert.lastSeen);
      continue;
    }

    const device = findDevice(lookup, alert.deviceName);
    if (!device) {
      result.failed++;
      result.issues.push({
        deviceName: alert.deviceName,
        message: `设备不存在：${alert.deviceName}（先跑 npm run db:seed，或在「数据源」页给这个主机名加设备别名）`,
      });
      continue;
    }

    if (alert.state === 'RESOLVED') {
      await flush();
      const open = await findOpenCycle(tenantId, device.id, alert);
      if (!open) {
        result.deduped++;
        continue;
      }
      await closeExisting(open, result, alert.lastSeen);
      if (alert.externalKey) existing.set(alert.externalKey, open);
      continue;
    }

    if (hit) {
      if (alert.refreshOnDuplicate && hit.status !== 'RESOLVED') {
        const seen = alert.lastSeen ?? now;
        if (seen.getTime() > hit.lastSeen.getTime()) {
          if (hit.pending && alert.externalKey) {
            const queued = pendingByKey.get(alert.externalKey);
            if (queued) queued.lastSeen = seen;
          } else if (!hit.pending) {
            await db.alert.update({ where: { id: hit.id }, data: { lastSeen: seen } });
          }
          hit.lastSeen = seen;
        }
      }
      result.deduped++;
      continue;
    }

    const input: RecordAlertInput = {
      deviceId: device.id,
      tenantId,
      type: alert.type,
      severity: alert.severity,
      metric: alert.metric ?? null,
      value: alert.value ?? null,
      threshold: alert.threshold ?? null,
      message: alert.message,
      count: alert.count,
      firstSeen: alert.firstSeen,
      lastSeen: alert.lastSeen,
      externalKey: alert.externalKey ?? null,
      source,
      raw: alert.raw,
    };
    pending.push(input);
    if (alert.externalKey) {
      pendingByKey.set(alert.externalKey, input);
      existing.set(alert.externalKey, {
        id: '',
        status: 'ACTIVE',
        lastSeen: alert.lastSeen ?? alert.firstSeen,
        pending: true,
      });
    }
  }

  await flush();
  return result;
}

async function closeExisting(hit: ExistingAlert, result: IngestResult, seen?: Date): Promise<void> {
  if (hit.status === 'RESOLVED') {
    result.deduped++;
    return;
  }
  await resolveParentAlert(hit.id);
  if (seen && seen.getTime() > hit.lastSeen.getTime()) {
    await db.alert.update({ where: { id: hit.id }, data: { lastSeen: seen } });
    hit.lastSeen = seen;
  }
  hit.status = 'RESOLVED';
  result.resolved++;
}

/** 恢复通知对不上这一次的 startsAt 时，仍关闭同一 Alertmanager fingerprint 的活跃周期。 */
async function findOpenCycle(
  tenantId: string,
  deviceId: string,
  alert: RawAlert,
): Promise<ExistingAlert | null> {
  const prefix = alert.externalKey?.includes('|')
    ? alert.externalKey.slice(0, alert.externalKey.indexOf('|') + 1)
    : null;
  if (prefix) {
    return db.alert.findFirst({
      where: {
        tenantId,
        externalKey: { startsWith: prefix },
        status: { in: ['ACTIVE', 'SUPPRESSED'] },
      },
      orderBy: { cycleStart: 'desc' },
      select: { id: true, status: true, lastSeen: true },
    });
  }

  const fingerprint = await db.alertFingerprint.findFirst({
    where: { deviceId, type: alert.type, metric: alert.metric ?? null },
    select: { id: true },
  });
  if (!fingerprint) return null;
  return db.alert.findFirst({
    where: {
      tenantId,
      fingerprintId: fingerprint.id,
      status: { in: ['ACTIVE', 'SUPPRESSED'] },
    },
    orderBy: { cycleStart: 'desc' },
    select: { id: true, status: true, lastSeen: true },
  });
}
