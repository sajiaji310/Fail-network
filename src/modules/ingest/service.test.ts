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
      where: { tenantId_name: { tenantId: 'default', name: DEVICE } },
      create: { name: DEVICE, type: 'SWITCH', layer: 3, site: '测试' },
      update: {},
    });
    await db.alert.deleteMany({ where: { externalKey: { startsWith: EXT_PREFIX } } });
  });

  afterAll(async () => {
    await db.alert.deleteMany({ where: { externalKey: { startsWith: EXT_PREFIX } } });
    const device = await db.device.findUnique({
      where: { tenantId_name: { tenantId: 'default', name: DEVICE } },
    });
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

  it('同一外部 ID 在不同租户各自入库', async () => {
    const other = 'TEST-INGEST-OTHER';
    await db.device.upsert({
      where: { tenantId_name: { tenantId: 'tenant-b', name: other } },
      create: { name: other, type: 'SWITCH', layer: 3, site: '测试', tenantId: 'tenant-b' },
      update: { tenantId: 'tenant-b' },
    });
    const key = `${EXT_PREFIX}shared-tenant`;
    const at = new Date('2026-11-19T08:00:00Z');
    const row = {
      externalKey: key,
      metric: 'TenantProbe',
      firstSeen: at,
      lastSeen: at,
    };
    const first = await ingestAlerts('test', [alert(row)], { tenantId: 'default' });
    const second = await ingestAlerts('test', [alert({ ...row, deviceName: other })], {
      tenantId: 'tenant-b',
    });
    expect(first.accepted).toBe(1);
    expect(second.accepted).toBe(1);

    await db.alert.deleteMany({ where: { tenantId: 'tenant-b', externalKey: key } });
    const device = await db.device.findUnique({
      where: { tenantId_name: { tenantId: 'tenant-b', name: other } },
    });
    if (device) {
      await db.alertFingerprint.deleteMany({ where: { deviceId: device.id } });
      await db.device.delete({ where: { id: device.id } });
    }
  });

  it('两个租户可以各有一台同名设备', async () => {
    const name = 'TEST-SAME-NAME';
    const first = await db.device.upsert({
      where: { tenantId_name: { tenantId: 'default', name } },
      create: { name, type: 'SWITCH', layer: 3, site: '测试', tenantId: 'default' },
      update: {},
    });
    const second = await db.device.upsert({
      where: { tenantId_name: { tenantId: 'tenant-b', name } },
      create: { name, type: 'SWITCH', layer: 3, site: '测试', tenantId: 'tenant-b' },
      update: {},
    });
    expect(first.id).not.toBe(second.id);
    await db.device.delete({ where: { id: first.id } });
    await db.device.delete({ where: { id: second.id } });
  });

  it('恢复通知关掉已有周期，相同外部键的再次 firing 只刷新 lastSeen', async () => {
    const key = `${EXT_PREFIX}am-cycle`;
    const at = new Date('2026-11-19T05:00:00Z');
    const opened = await ingestAlerts('test', [
      alert({
        externalKey: key,
        metric: 'Gi1/0/9',
        firstSeen: at,
        lastSeen: at,
        state: 'FIRING',
        refreshOnDuplicate: true,
      }),
    ]);
    expect(opened.accepted).toBe(1);

    const resolved = await ingestAlerts('test', [
      alert({
        externalKey: key,
        metric: 'Gi1/0/9',
        firstSeen: at,
        lastSeen: new Date('2026-11-19T05:10:00Z'),
        state: 'RESOLVED',
      }),
    ]);
    expect(resolved.resolved).toBe(1);
    expect(resolved.accepted).toBe(0);

    const again = await ingestAlerts('test', [
      alert({
        externalKey: key,
        metric: 'Gi1/0/9',
        firstSeen: at,
        lastSeen: new Date('2026-11-19T05:12:00Z'),
        state: 'FIRING',
        refreshOnDuplicate: true,
      }),
    ]);
    expect(again.accepted).toBe(0);
    expect(again.deduped).toBe(1);

    const row = await db.alert.findFirst({
      where: { tenantId: 'default', externalKey: key },
      select: { status: true, lastSeen: true },
    });
    expect(row?.status).toBe('RESOLVED');
    expect(row?.lastSeen.toISOString()).toBe('2026-11-19T05:10:00.000Z');

    const next = await ingestAlerts('test', [
      alert({
        externalKey: `${key}-next`,
        metric: 'Gi1/0/9',
        firstSeen: new Date('2026-11-19T05:20:00Z'),
        state: 'FIRING',
      }),
    ]);
    expect(next.accepted).toBe(1);
  });

  it('同一批里父告警先到，子告警记为被压制而不是回溯', async () => {
    const deviceName = 'TEST-INGEST-ORDER-A';
    await db.device.upsert({
      where: { tenantId_name: { tenantId: 'default', name: deviceName } },
      create: { name: deviceName, type: 'SWITCH', layer: 3, site: '测试' },
      update: {},
    });
    const at = new Date('2030-01-01T06:00:00Z');
    const result = await ingestAlerts('test', [
      alert({
        externalKey: `${EXT_PREFIX}order-parent`,
        deviceName,
        type: 'DEVICE_UNREACHABLE',
        severity: 'P0',
        metric: 'snmp',
        firstSeen: at,
      }),
      alert({
        externalKey: `${EXT_PREFIX}order-child`,
        deviceName,
        type: 'LINK_DOWN',
        metric: 'Gi1/0/8',
        firstSeen: new Date(at.getTime() + 60_000),
      }),
    ]);
    expect(result.accepted).toBe(2);
    expect(result.suppressed).toBe(1);
    expect(result.retroSuppressed).toBe(0);

    const child = await db.alert.findFirst({
      where: { externalKey: `${EXT_PREFIX}order-child` },
      select: { status: true, suppressedByAlertId: true },
    });
    const parent = await db.alert.findFirst({
      where: { externalKey: `${EXT_PREFIX}order-parent` },
      select: { id: true },
    });
    expect(child?.status).toBe('SUPPRESSED');
    expect(child?.suppressedByAlertId).toBe(parent?.id);

    const device = await db.device.findUnique({
      where: { tenantId_name: { tenantId: 'default', name: deviceName } },
    });
    if (device) {
      await db.alert.deleteMany({ where: { fingerprint: { deviceId: device.id } } });
      await db.alertFingerprint.deleteMany({ where: { deviceId: device.id } });
      await db.device.delete({ where: { id: device.id } });
    }
  });

  it('同一批里子告警先到，父告警晚到记为回溯', async () => {
    const deviceName = 'TEST-INGEST-ORDER-B';
    await db.device.upsert({
      where: { tenantId_name: { tenantId: 'default', name: deviceName } },
      create: { name: deviceName, type: 'SWITCH', layer: 3, site: '测试' },
      update: {},
    });
    const at = new Date('2030-02-01T07:00:00Z');
    const result = await ingestAlerts('test', [
      alert({
        externalKey: `${EXT_PREFIX}retro-child`,
        deviceName,
        type: 'LINK_DOWN',
        metric: 'Gi1/0/7',
        firstSeen: at,
      }),
      alert({
        externalKey: `${EXT_PREFIX}retro-parent`,
        deviceName,
        type: 'DEVICE_OFFLINE',
        severity: 'P0',
        metric: 'icmp',
        firstSeen: new Date(at.getTime() + 60_000),
      }),
    ]);
    expect(result.accepted).toBe(2);
    expect(result.suppressed).toBe(0);
    expect(result.retroSuppressed).toBe(1);

    const child = await db.alert.findFirst({
      where: { externalKey: `${EXT_PREFIX}retro-child` },
      select: { status: true, suppressedByAlertId: true },
    });
    expect(child?.status).toBe('SUPPRESSED');
    expect(child?.suppressedByAlertId).toBeTruthy();

    const device = await db.device.findUnique({
      where: { tenantId_name: { tenantId: 'default', name: deviceName } },
    });
    if (device) {
      await db.alert.deleteMany({ where: { fingerprint: { deviceId: device.id } } });
      await db.alertFingerprint.deleteMany({ where: { deviceId: device.id } });
      await db.device.delete({ where: { id: device.id } });
    }
  });
});
