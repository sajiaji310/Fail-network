import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import type { RawAlert } from './schema';
import { ingestAlerts } from './service';

const DEVICE = 'TEST-INGEST-DEV';
const EXT_PREFIX = 'TEST-INGEST-';
const hasDb = Boolean(process.env.DATABASE_URL);

function alert(overrides: Partial<RawAlert> = {}): RawAlert {
  const at = new Date('2026-11-19T02:00:00Z');
  const firstSeen = overrides.firstSeen ?? at;
  return {
    externalKey: `${EXT_PREFIX}${Math.random().toString(36).slice(2, 10)}`,
    deviceName: DEVICE,
    type: 'LINK_DOWN',
    severity: 'P1',
    metric: 'Gi1/0/1',
    message: '测试链路 Down',
    firstSeen,
    // lastSeen 必须跟随 firstSeen，否则 30 分钟周期判定会被一个"超前 70 分钟"的 lastSeen 带偏
    lastSeen: overrides.lastSeen ?? firstSeen,
    ...overrides,
  };
}

describe.skipIf(!hasDb)('ingestAlerts（依赖真实 DB）', () => {
  beforeAll(async () => {
    await db.device.upsert({
      where: { name: DEVICE },
      create: { name: DEVICE, type: 'SWITCH', layer: 3, site: '测试' },
      update: {},
    });
    await db.alert.deleteMany({ where: { externalKey: { startsWith: EXT_PREFIX } } });
  });

  afterAll(async () => {
    await db.alert.deleteMany({ where: { externalKey: { startsWith: EXT_PREFIX } } });
    const device = await db.device.findUnique({ where: { name: DEVICE } });
    if (device) {
      await db.alertFingerprint.deleteMany({ where: { deviceId: device.id } });
      await db.device.delete({ where: { id: device.id } });
    }
    await db.$disconnect();
  });

  it('首次导入入库，二次导入按 externalKey 去重', async () => {
    const row = alert({ externalKey: `${EXT_PREFIX}idem-1` });

    const first = await ingestAlerts('test', [row]);
    expect(first.accepted).toBe(1);
    expect(first.deduped).toBe(0);
    expect(first.failed).toBe(0);

    const second = await ingestAlerts('test', [row]);
    expect(second.accepted).toBe(0);
    expect(second.deduped).toBe(1);
  });

  it('设备不存在只记失败，不影响同批其它行', async () => {
    const result = await ingestAlerts('test', [
      alert({ externalKey: `${EXT_PREFIX}missing`, deviceName: 'NO-SUCH-DEVICE' }),
      alert({ externalKey: `${EXT_PREFIX}ok`, metric: 'Gi1/0/2' }),
    ]);
    expect(result.failed).toBe(1);
    expect(result.accepted).toBe(1);
    expect(result.issues[0]!.message).toContain('设备不存在');
  });

  it('同指纹 30 分钟内上报两次 → 只保留一行，第二行进 deduped（AC-13）', async () => {
    const at = new Date('2026-11-19T03:15:30Z');
    const result = await ingestAlerts('test', [
      alert({ externalKey: `${EXT_PREFIX}cycle-a`, metric: 'Gi1/0/3', firstSeen: at }),
      alert({
        externalKey: `${EXT_PREFIX}cycle-b`,
        metric: 'Gi1/0/3',
        firstSeen: new Date('2026-11-19T03:15:59Z'),
      }),
    ]);
    expect(result.accepted).toBe(1);
    expect(result.deduped).toBe(1);
  });

  it('跨 30 分钟周期边界产生两条发生记录（AC-14）', async () => {
    const result = await ingestAlerts('test', [
      alert({
        externalKey: `${EXT_PREFIX}next-a`,
        metric: 'Gi1/0/4',
        firstSeen: new Date('2026-11-19T04:00:00Z'),
      }),
      alert({
        externalKey: `${EXT_PREFIX}next-b`,
        metric: 'Gi1/0/4',
        firstSeen: new Date('2026-11-19T04:31:00Z'),
      }),
    ]);
    expect(result.accepted).toBe(2);
  });
});
