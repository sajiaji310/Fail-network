import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { resolveParentAlert } from './suppress';
import { ingestAlerts } from '@/modules/ingest/service';
import type { RawAlert } from '@/modules/ingest/schema';

const DEVICE = 'TEST-T04-DEV';
const EXT = 'TEST-T04-';
const INC_PREFIX = 'INC-T04-';
const hasDb = Boolean(process.env.DATABASE_URL);

let deviceId = '';

/** 基准时间取 8 小时前，确保所有用例（最多 +5 小时）都落在"过去"，不会与真实数据抢窗口 */
const BASE = new Date(Date.now() - 8 * 60 * 60 * 1000);
const minutesAfter = (base: Date, m: number) => new Date(base.getTime() + m * 60_000);

function row(
  partial: Partial<RawAlert> & Pick<RawAlert, 'type' | 'firstSeen'>,
  seq: string,
): RawAlert {
  return {
    externalKey: `${EXT}${seq}`,
    deviceName: DEVICE,
    severity: 'P1',
    metric: 'Gi1/0/1',
    message: `${partial.type} 测试`,
    lastSeen: partial.firstSeen,
    ...partial,
  } as RawAlert;
}

async function alertsOfType(type: string) {
  return db.alert.findMany({
    where: { fingerprint: { deviceId, type } },
    orderBy: { cycleStart: 'asc' },
    select: {
      id: true,
      status: true,
      count: true,
      firstSeen: true,
      lastSeen: true,
      suppressedByAlertId: true,
      incidentId: true,
    },
  });
}

describe.skipIf(!hasDb)('T04 生命周期与抑制（依赖真实 DB）', () => {
  beforeAll(async () => {
    const device = await db.device.upsert({
      where: { name: DEVICE },
      create: { name: DEVICE, type: 'SWITCH', layer: 3, site: '测试' },
      update: {},
    });
    deviceId = device.id;
    await wipe();
  });

  afterAll(async () => {
    await wipe();
    await db.device.delete({ where: { name: DEVICE } }).catch(() => undefined);
  });

  async function wipe() {
    await db.incident.deleteMany({ where: { code: { startsWith: INC_PREFIX } } });
    await db.alert.deleteMany({ where: { fingerprint: { device: { name: DEVICE } } } });
    await db.alertFingerprint.deleteMany({ where: { deviceId } });
  }

  /**
   * 用例隔离：前序用例留下的 ACTIVE 告警会被后续父告警的回溯窗口（2 小时）扫到，
   * 导致 retroSuppressed 计数被污染。开新用例前先清场。
   */
  async function resetDeviceAlerts() {
    await db.alert.updateMany({
      where: { fingerprint: { deviceId }, status: 'ACTIVE' },
      data: { status: 'RESOLVED' },
    });
    // 父告警即使处于 SUPPRESSED 也要收掉，否则会继续压制新子告警
    await db.alert.updateMany({
      where: {
        fingerprint: {
          deviceId,
          type: { in: ['DEVICE_UNREACHABLE', 'DEVICE_OFFLINE', 'DEVICE_DOWN'] },
        },
        status: { in: ['ACTIVE', 'SUPPRESSED'] },
      },
      data: { status: 'RESOLVED' },
    });
  }

  it('AC-13：30 分钟内同指纹连报 3 次 → 只有 1 行，count=3，lastSeen 前移', async () => {
    const t0 = BASE;
    await ingestAlerts('test', [row({ type: 'PORT_FLAP', firstSeen: t0 }, 'ac13-1')]);
    await ingestAlerts('test', [
      row({ type: 'PORT_FLAP', firstSeen: minutesAfter(t0, 10) }, 'ac13-2'),
    ]);
    const third = await ingestAlerts('test', [
      row({ type: 'PORT_FLAP', firstSeen: minutesAfter(t0, 20) }, 'ac13-3'),
    ]);

    expect(third.accepted).toBe(0);
    expect(third.deduped).toBe(1);

    const rows = await alertsOfType('PORT_FLAP');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.count).toBe(3);
    expect(rows[0]?.firstSeen.toISOString()).toBe(t0.toISOString());
    expect(rows[0]?.lastSeen.toISOString()).toBe(minutesAfter(t0, 20).toISOString());
    expect(rows[0]?.status).toBe('ACTIVE');
  });

  it('AC-01：同一批（同 externalKey）再导一次 → 不新增、count 不变', async () => {
    const t0 = minutesAfter(BASE, 60);
    const batch = [row({ type: 'CRC_ERROR', firstSeen: t0 }, 'ac01-1')];

    const first = await ingestAlerts('test', batch);
    expect(first.accepted).toBe(1);

    const before = await alertsOfType('CRC_ERROR');
    const second = await ingestAlerts('test', batch);
    expect(second.accepted).toBe(0);
    expect(second.deduped).toBe(1);

    const after = await alertsOfType('CRC_ERROR');
    expect(after).toHaveLength(before.length);
    expect(after[0]?.count).toBe(1);
  });

  it('AC-14：RESOLVED 后超过 30 分钟再上报 → 新建周期，firstSeen 重置', async () => {
    const t0 = minutesAfter(BASE, 90);
    await ingestAlerts('test', [row({ type: 'HIGH_LATENCY', firstSeen: t0 }, 'ac14-1')]);
    const [created] = await alertsOfType('HIGH_LATENCY');
    expect(created).toBeDefined();
    await db.alert.update({ where: { id: created!.id }, data: { status: 'RESOLVED' } });

    const t1 = minutesAfter(t0, 40);
    const res = await ingestAlerts('test', [
      row({ type: 'HIGH_LATENCY', firstSeen: t1 }, 'ac14-2'),
    ]);
    expect(res.accepted).toBe(1);

    const rows = await alertsOfType('HIGH_LATENCY');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.status).toBe('RESOLVED');
    expect(rows[1]?.status).toBe('ACTIVE');
    expect(rows[1]?.firstSeen.toISOString()).toBe(t1.toISOString());
    expect(rows[1]?.count).toBe(1);
  });

  it('AC-14 反面：活跃周期超过 30 分钟 → 旧周期 RESOLVED，新开一行', async () => {
    const t0 = minutesAfter(BASE, 150);
    await ingestAlerts('test', [row({ type: 'OPTICAL_RX_LOW', firstSeen: t0 }, 'cyc-1')]);
    const res = await ingestAlerts('test', [
      row({ type: 'OPTICAL_RX_LOW', firstSeen: minutesAfter(t0, 31) }, 'cyc-2'),
    ]);
    expect(res.accepted).toBe(1);

    const rows = await alertsOfType('OPTICAL_RX_LOW');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.status).toBe('RESOLVED');
    expect(rows[1]?.status).toBe('ACTIVE');
  });

  it('AC-02：父告警 ACTIVE 时，同设备端口告警落 SUPPRESSED 并记录溯源', async () => {
    const t0 = minutesAfter(BASE, 200);
    const parentRes = await ingestAlerts('test', [
      row({ type: 'DEVICE_UNREACHABLE', severity: 'P0', metric: 'snmp', firstSeen: t0 }, 'ac02-p'),
    ]);
    expect(parentRes.accepted).toBe(1);

    const childRes = await ingestAlerts('test', [
      row({ type: 'LINK_DOWN', firstSeen: minutesAfter(t0, 1) }, 'ac02-c'),
    ]);
    expect(childRes.accepted).toBe(1);
    expect(childRes.suppressed).toBe(1);

    const parents = await alertsOfType('DEVICE_UNREACHABLE');
    const children = await alertsOfType('LINK_DOWN');
    expect(children[0]?.status).toBe('SUPPRESSED');
    expect(children[0]?.suppressedByAlertId).toBe(parents[0]?.id);
  });

  it('AC-19 守卫：父告警到达后，同设备根因告警不被抑制', async () => {
    // 复用上一条用例已 ACTIVE 的 DEVICE_UNREACHABLE（同设备同时间窗）
    const before = await alertsOfType('LINECARD_FAILURE');
    expect(before).toHaveLength(0);

    await ingestAlerts('test', [
      row(
        {
          type: 'LINECARD_FAILURE',
          severity: 'P0',
          metric: 'Slot3',
          firstSeen: minutesAfter(BASE, 201),
        },
        'root-1',
      ),
    ]);

    const rows = await alertsOfType('LINECARD_FAILURE');
    expect(rows[0]?.status).toBe('ACTIVE');
    expect(rows[0]?.suppressedByAlertId).toBeNull();
  });

  it('B9：父告警晚到 → 子告警撤出事件，剩余 < 3 条自动关闭（AUTO_CLOSED）', async () => {
    // AC-02 留下的活跃父告警会抢先压掉这批子告警，先把场清干净
    await resetDeviceAlerts();

    const t0 = minutesAfter(BASE, 240);
    // 三条子告警先到
    for (const [i, type] of ['PACKET_LOSS', 'JITTER_HIGH', 'INTERFACE_ERROR'].entries()) {
      await ingestAlerts('test', [row({ type, firstSeen: minutesAfter(t0, i) }, `b9-${type}`)]);
    }

    const children = await db.alert.findMany({
      where: {
        fingerprint: { deviceId, type: { in: ['PACKET_LOSS', 'JITTER_HIGH', 'INTERFACE_ERROR'] } },
      },
      select: { id: true },
    });
    expect(children).toHaveLength(3);

    // 手工造一个事件并把三条子告警归属进去（聚合在 T05，这里只验 B9 的撤出行为）
    const incident = await db.incident.create({
      data: {
        code: `${INC_PREFIX}B9`,
        title: 'T04 B9 测试事件',
        severity: 'P1',
        startedAt: t0,
      },
    });
    await db.alert.updateMany({
      where: { id: { in: children.map((c) => c.id) } },
      data: { incidentId: incident.id },
    });

    // 父告警晚到
    const res = await ingestAlerts('test', [
      row(
        { type: 'DEVICE_OFFLINE', severity: 'P0', metric: 'icmp', firstSeen: minutesAfter(t0, 5) },
        'b9-parent',
      ),
    ]);
    expect(res.retroSuppressed).toBe(3);
    expect(res.autoClosedIncidents).toBe(1);

    const after = await db.alert.findMany({
      where: { id: { in: children.map((c) => c.id) } },
      select: { status: true },
    });
    expect(after.every((a) => a.status === 'SUPPRESSED')).toBe(true);

    const updated = await db.incident.findUnique({ where: { id: incident.id } });
    expect(updated?.status).toBe('CLOSED');
    expect(updated?.closedReason).toBe('AUTO_CLOSED');
    expect(updated?.mttrSeconds).not.toBeNull();
  });

  it('父告警恢复 → 它压制过的子告警精确回滚为 ACTIVE', async () => {
    const parents = await alertsOfType('DEVICE_OFFLINE');
    expect(parents).toHaveLength(1);

    const { restored } = await resolveParentAlert(parents[0]!.id);
    expect(restored.length).toBe(3);

    const children = await db.alert.findMany({
      where: { id: { in: restored } },
      select: { status: true, suppressedByAlertId: true },
    });
    expect(children.every((c) => c.status === 'ACTIVE')).toBe(true);
    expect(children.every((c) => c.suppressedByAlertId === null)).toBe(true);
  });

  it('B9 边界：撤出后事件仍 ≥ 3 条告警则不关闭', async () => {
    await resetDeviceAlerts();

    const t0 = minutesAfter(BASE, 300);
    // 3 条设备级根因告警（不可抑制）+ 2 条指标告警（会被父告警压掉）
    const roots = [
      { type: 'LINECARD_FAILURE', metric: 'Slot5' },
      { type: 'FAN_FAILURE', metric: 'FAN-2' },
      { type: 'POWER_SUPPLY_FAILURE', metric: 'PSU-1' },
    ];
    for (const [i, r] of roots.entries()) {
      await ingestAlerts('test', [
        row(
          { type: r.type, severity: 'P0', metric: r.metric, firstSeen: minutesAfter(t0, i) },
          `keep-r${i}`,
        ),
      ]);
    }
    for (const [i, type] of ['CPU_HIGH', 'DNS_TIMEOUT'].entries()) {
      await ingestAlerts('test', [row({ type, firstSeen: minutesAfter(t0, i) }, `keep-c${i}`)]);
    }

    const keys = [
      `${EXT}keep-r0`,
      `${EXT}keep-r1`,
      `${EXT}keep-r2`,
      `${EXT}keep-c0`,
      `${EXT}keep-c1`,
    ];
    const members = await db.alert.findMany({
      where: { externalKey: { in: keys } },
      select: { id: true },
    });
    expect(members).toHaveLength(5);

    const incident = await db.incident.create({
      data: {
        code: `${INC_PREFIX}B9B`,
        title: 'T04 撤出后仍达标事件',
        severity: 'P1',
        startedAt: t0,
      },
    });
    await db.alert.updateMany({
      where: { id: { in: members.map((m) => m.id) } },
      data: { incidentId: incident.id },
    });

    const parent = await ingestAlerts('test', [
      row(
        {
          type: 'DEVICE_UNREACHABLE',
          severity: 'P0',
          metric: 'snmp',
          firstSeen: minutesAfter(t0, 10),
        },
        'keep-parent',
      ),
    ]);
    // 只有 2 条 CHILD 被压制，3 条 ROOT 保留
    expect(parent.retroSuppressed).toBe(2);
    expect(parent.autoClosedIncidents).toBe(0);

    const updated = await db.incident.findUnique({ where: { id: incident.id } });
    expect(updated?.status).toBe('OPEN');
    expect(updated?.closedReason).toBeNull();
  });

  it('AC-14 边界：RESOLVED 后同一分钟内重报 → 新建而非合并进已关闭周期', async () => {
    await resetDeviceAlerts();

    const t0 = minutesAfter(BASE, 360);
    await ingestAlerts('test', [row({ type: 'SESSION_HIGH', firstSeen: t0 }, 'same-min-1')]);
    const [first] = await alertsOfType('SESSION_HIGH');
    expect(first).toBeDefined();
    await db.alert.update({ where: { id: first!.id }, data: { status: 'RESOLVED' } });

    // 同一分钟内的不同秒：若锚点被取整到分钟，这里会撞唯一键并被误合并
    const t1 = new Date(t0.getTime() + 20_000);
    const res = await ingestAlerts('test', [
      row({ type: 'SESSION_HIGH', firstSeen: t1 }, 'same-min-2'),
    ]);
    expect(res.accepted).toBe(1);

    const rows = await alertsOfType('SESSION_HIGH');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.status).toBe('RESOLVED');
    expect(rows[1]?.status).toBe('ACTIVE');
    expect(rows[1]?.firstSeen.toISOString()).toBe(t1.toISOString());
  });
});
