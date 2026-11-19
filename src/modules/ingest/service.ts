import { db } from '@/lib/db';
import { recordAlert, type ParentCache } from '@/modules/alerts/service';
import type { ParseIssue, RawAlert } from './schema';

export type IngestIssue = ParseIssue & { deviceName?: string };

export type IngestResult = {
  source: string;
  /** 新落库的告警周期数（含 30 分钟到期后重开的周期） */
  accepted: number;
  /** 外部 ID 命中 或 命中 30 分钟内的同指纹周期（AC-13）→ 只累加 count / lastSeen */
  deduped: number;
  /** 本次新落库即被父告警抑制的条数（AC-02） */
  suppressed: number;
  /** 本次落库的父告警回溯压掉的历史告警数（B9） */
  retroSuppressed: number;
  /** 因 B9 撤出告警而自动关闭的事件数 */
  autoClosedIncidents: number;
  failed: number;
  issues: IngestIssue[];
};

/**
 * 告警导入编排：设备解析 → 外部 ID 幂等 → 交给 alerts 模块做归一化与抑制。
 * 这里不实现任何生命周期/抑制规则，规则全部在 `modules/alerts/*`。
 */
export async function ingestAlerts(
  source: string,
  alerts: readonly RawAlert[],
): Promise<IngestResult> {
  const result: IngestResult = {
    source,
    accepted: 0,
    deduped: 0,
    suppressed: 0,
    retroSuppressed: 0,
    autoClosedIncidents: 0,
    failed: 0,
    issues: [],
  };
  if (alerts.length === 0) return result;

  const names = [...new Set(alerts.map((a) => a.deviceName))];
  const devices = await db.device.findMany({
    where: { name: { in: names } },
    select: { id: true, name: true },
  });
  const deviceByName = new Map(devices.map((d) => [d.name, d.id]));

  const externalKeys = alerts.map((a) => a.externalKey).filter((k): k is string => !!k);
  const existing = new Set(
    (
      await db.alert.findMany({
        where: { externalKey: { in: externalKeys } },
        select: { externalKey: true },
      })
    ).map((a) => a.externalKey),
  );

  const parentCache: ParentCache = new Map();
  const now = new Date();

  for (const alert of alerts) {
    const deviceId = deviceByName.get(alert.deviceName);
    if (!deviceId) {
      result.failed++;
      result.issues.push({
        deviceName: alert.deviceName,
        message: `设备不存在：${alert.deviceName}（先跑 npm run db:seed 或检查名称拼写）`,
      });
      continue;
    }

    if (alert.externalKey && existing.has(alert.externalKey)) {
      result.deduped++;
      continue;
    }

    try {
      const outcome = await recordAlert(
        {
          deviceId,
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
          parentCache,
        },
        now,
      );

      if (outcome.action === 'ACCUMULATED') {
        result.deduped++;
      } else {
        result.accepted++;
        if (outcome.suppressed) result.suppressed++;
      }
      result.retroSuppressed += outcome.retroSuppressed;
      result.autoClosedIncidents += outcome.autoClosedIncidents;
      if (alert.externalKey) existing.add(alert.externalKey);
    } catch (error) {
      result.failed++;
      result.issues.push({
        deviceName: alert.deviceName,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}
