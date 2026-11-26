import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { markStaleBatches, submitIngest } from './batch';
import type { RawAlert } from './schema';

const DEVICE = 'TEST-BATCH-DEV';
const PREFIX = 'TEST-BATCH-';
const hasDb = Boolean(process.env.DATABASE_URL);

function alert(externalKey: string, metric: string): RawAlert {
  const at = new Date('2026-11-20T05:00:00Z');
  return {
    externalKey: `${PREFIX}${externalKey}`,
    deviceName: DEVICE,
    type: 'LINK_DOWN',
    severity: 'P2',
    metric,
    message: '批处理测试',
    firstSeen: at,
    lastSeen: at,
  };
}

describe.skipIf(!hasDb)('导入批处理（依赖真实 DB）', () => {
  beforeAll(async () => {
    await db.device.upsert({
      where: { tenantId_name: { tenantId: 'default', name: DEVICE } },
      create: { name: DEVICE, type: 'SWITCH', layer: 3, site: '测试' },
      update: {},
    });
    await db.alert.deleteMany({ where: { externalKey: { startsWith: PREFIX } } });
    await db.ingestBatch.deleteMany({ where: { source: { startsWith: PREFIX } } });
  });

  afterAll(async () => {
    await db.alert.deleteMany({ where: { externalKey: { startsWith: PREFIX } } });
    await db.ingestBatch.deleteMany({ where: { source: { startsWith: PREFIX } } });
    const device = await db.device.findUnique({
      where: { tenantId_name: { tenantId: 'default', name: DEVICE } },
    });
    if (device) {
      await db.alertFingerprint.deleteMany({ where: { deviceId: device.id } });
      await db.device.delete({ where: { id: device.id } });
    }
    await db.$disconnect();
  });

  it('小批量同步跑完，批次行记录计数与耗时', async () => {
    const source = `${PREFIX}sync`;
    const outcome = await submitIngest({
      source,
      kind: 'json',
      alerts: [alert('sync-1', 'Gi1/0/1'), alert('sync-2', 'Gi1/0/2')],
      tenantId: 'default',
      createdBy: 'test',
    });

    expect(outcome.mode).toBe('sync');
    if (outcome.mode !== 'sync') return;
    expect(outcome.result.accepted).toBe(2);

    const batch = await db.ingestBatch.findFirst({ where: { source } });
    expect(batch).not.toBeNull();
    expect(batch!.status).toBe('DONE');
    expect(batch!.total).toBe(2);
    expect(batch!.processed).toBe(2);
    expect(batch!.accepted).toBe(2);
    expect(batch!.finishedAt).not.toBeNull();
    expect(batch!.durationMs).not.toBeNull();
  });

  it('设备不存在的行计入 failed，批次仍然完成', async () => {
    const source = `${PREFIX}partial`;
    const outcome = await submitIngest({
      source,
      kind: 'alertmanager',
      alerts: [{ ...alert('partial-1', 'Gi1/0/3'), deviceName: 'NO-SUCH-DEVICE' }],
      tenantId: 'default',
      createdBy: 'test',
    });
    expect(outcome.mode).toBe('sync');
    if (outcome.mode !== 'sync') return;
    expect(outcome.result.failed).toBe(1);

    const batch = await db.ingestBatch.findFirst({ where: { source } });
    expect(batch!.status).toBe('DONE');
    expect(batch!.failed).toBe(1);
    expect(Array.isArray(batch!.issues)).toBe(true);
  });

  it('进程中断留下的 RUNNING 批次会被标记失败，而不是永远转圈', async () => {
    const stale = await db.ingestBatch.create({
      data: {
        source: `${PREFIX}stale`,
        kind: 'json',
        status: 'RUNNING',
        total: 100,
        processed: 40,
        startedAt: new Date(Date.now() - 30 * 60_000),
      },
      select: { id: true },
    });

    const count = await markStaleBatches();
    expect(count).toBeGreaterThanOrEqual(1);

    const row = await db.ingestBatch.findUniqueOrThrow({ where: { id: stale.id } });
    expect(row.status).toBe('FAILED');
    expect(row.error).toContain('批次中断');
  });
});
