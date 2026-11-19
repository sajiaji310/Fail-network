import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { signatureOf } from '@/modules/alerts/fingerprint';
import type { ParseIssue, RawAlert } from './schema';

export type IngestIssue = ParseIssue & { deviceName?: string };

export type IngestResult = {
  source: string;
  accepted: number;
  deduped: number;
  suppressed: number;
  failed: number;
  issues: IngestIssue[];
};

/** 周期起点取整到分钟：同一批数据重复导入才能命中 (fingerprintId, cycleStart) 唯一键 */
function toCycleStart(date: Date): Date {
  const d = new Date(date);
  d.setSeconds(0, 0);
  return d;
}

/**
 * 告警落库：外部 ID 幂等 → 指纹 upsert → 周期唯一键兜底。
 * 抑制（父告警压制子告警）在 T04 实现，此处恒为 0。
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

    const signature = signatureOf(deviceId, alert.type, alert.metric);
    const fingerprint = await db.alertFingerprint.upsert({
      where: { signature },
      create: {
        signature,
        deviceId,
        type: alert.type,
        metric: alert.metric,
        severity: alert.severity,
      },
      update: { severity: alert.severity },
    });

    // 先查后写：同周期重复导入走 deduped，不依赖唯一键异常（避免刷 prisma:error）
    const cycleStart = toCycleStart(alert.firstSeen);
    const existingCycle = await db.alert.findFirst({
      where: { fingerprintId: fingerprint.id, cycleStart },
      select: { id: true },
    });
    if (existingCycle) {
      result.deduped++;
      continue;
    }

    try {
      await db.alert.create({
        data: {
          fingerprintId: fingerprint.id,
          severity: alert.severity,
          value: alert.value,
          threshold: alert.threshold,
          message: alert.message,
          count: alert.count ?? 1,
          firstSeen: alert.firstSeen,
          lastSeen: alert.lastSeen ?? alert.firstSeen,
          cycleStart,
          externalKey: alert.externalKey,
          raw: { source, ...(alert.raw ?? {}) },
        },
      });
      result.accepted++;
      if (alert.externalKey) existing.add(alert.externalKey);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        result.deduped++;
        continue;
      }
      result.failed++;
      result.issues.push({
        deviceName: alert.deviceName,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}
