import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { signatureOf } from '@/modules/alerts/fingerprint';
import { runCorrelation } from '@/modules/correlation/service';
import { splitIncident } from './split';

/**
 * 拆分集成测试：真库 + 固定历史时间，避免和演示数据/其它用例互相干扰。
 * 重点验证三件事：告警归属、两边聚合重算、拆分留痕（statusLog + splitFromId）。
 */

const BASE = new Date('2026-11-11T02:00:00Z');
const min = (n: number) => new Date(BASE.getTime() + n * 60_000);

let seq = 0;

async function makeAlert(deviceName: string, type: string, at: Date): Promise<string> {
  const device = await db.device.findUniqueOrThrow({
    where: { tenantId_name: { tenantId: 'default', name: deviceName } },
    select: { id: true },
  });
  const metric = `split-test`;
  const signature = signatureOf(device.id, type, metric);
  const fingerprint = await db.alertFingerprint.upsert({
    where: { signature },
    create: { signature, deviceId: device.id, type, metric, severity: 'P1' },
    update: {},
  });
  seq++;
  const row = await db.alert.create({
    data: {
      fingerprintId: fingerprint.id,
      severity: 'P1',
      message: `${deviceName} ${type}`,
      firstSeen: at,
      lastSeen: at,
      cycleStart: at,
      externalKey: `SPLIT-${seq}`,
      status: 'ACTIVE',
    },
    select: { id: true },
  });
  return row.id;
}

async function makeIncident(alertIds: readonly string[]): Promise<string> {
  const alerts = await db.alert.findMany({
    where: { id: { in: [...alertIds] } },
    select: { firstSeen: true, lastSeen: true },
  });
  seq++;
  const created = await db.incident.create({
    data: {
      code: `INC-20261111-9${String(seq).padStart(2, '0')}`,
      title: '拆分测试事件',
      status: 'OPEN',
      severity: 'P1',
      startedAt: alerts.reduce(
        (minD, a) => (a.firstSeen < minD ? a.firstSeen : minD),
        alerts[0]!.firstSeen,
      ),
      lastSeen: alerts.reduce(
        (maxD, a) => (a.lastSeen > maxD ? a.lastSeen : maxD),
        alerts[0]!.lastSeen,
      ),
      clusterKey: `split-test-${seq}`,
    },
    select: { id: true },
  });
  await db.alert.updateMany({
    where: { id: { in: [...alertIds] } },
    data: { incidentId: created.id },
  });
  return created.id;
}

async function cleanup() {
  await db.alert.deleteMany({ where: { externalKey: { startsWith: 'SPLIT-' } } });
  await db.incident.deleteMany({
    where: {
      startedAt: { gte: new Date('2026-11-11T00:00:00Z'), lte: new Date('2026-11-12T00:00:00Z') },
    },
  });
}

beforeEach(cleanup);
afterAll(cleanup);

describe('splitIncident', () => {
  it('拆出的告警落到新事件，原事件重算聚合且保留至少一条', async () => {
    const ids = [
      await makeAlert('ACC-SW-01', 'LINK_DOWN', min(0)),
      await makeAlert('ACC-SW-01', 'PORT_FLAP', min(1)),
      await makeAlert('ACC-SW-01', 'CRC_ERROR', min(2)),
    ];
    const incidentId = await makeIncident(ids);

    const result = await splitIncident({
      idOrCode: incidentId,
      alertIds: [ids[2]!],
      note: '这条是换线余波',
      now: min(10),
    });
    expect(result).not.toBeNull();
    expect(result!.moved).toBe(1);
    expect(result!.source.alertCount).toBe(2);
    expect(result!.target.alertCount).toBe(1);

    const target = await db.incident.findUniqueOrThrow({
      where: { id: result!.target.id },
      select: { splitFromId: true, status: true, title: true, clusterKey: true },
    });
    expect(target.splitFromId).toBe(incidentId);
    expect(target.status).toBe('OPEN');
    expect(target.title).toContain('人工拆分');
    expect(target.clusterKey).not.toBeNull();

    const source = await db.incident.findUniqueOrThrow({
      where: { id: incidentId },
      select: { statusLog: true, severity: true, lastSeen: true },
    });
    expect(JSON.stringify(source.statusLog)).toContain('拆分 1 条告警');
    // 拆走最后一条后，原事件的 lastSeen 要跟着回收（聚合字段重算）
    expect(source.lastSeen.toISOString()).toBe(min(1).toISOString());
  });

  it('不能把全部告警都拆走', async () => {
    const ids = [
      await makeAlert('ACC-SW-02', 'LINK_DOWN', min(0)),
      await makeAlert('ACC-SW-02', 'PORT_FLAP', min(1)),
    ];
    const incidentId = await makeIncident(ids);

    await expect(
      splitIncident({ idOrCode: incidentId, alertIds: ids, now: min(5) }),
    ).rejects.toThrow(/至少保留 1 条/);
  });

  it('不属于该事件的告警直接拒绝，且不改动任何数据', async () => {
    const ids = [
      await makeAlert('ACC-SW-03', 'LINK_DOWN', min(0)),
      await makeAlert('ACC-SW-03', 'PORT_FLAP', min(1)),
    ];
    const incidentId = await makeIncident(ids);
    const stranger = await makeAlert('ACC-SW-04', 'LINK_DOWN', min(0));

    await expect(
      splitIncident({ idOrCode: incidentId, alertIds: [stranger], now: min(5) }),
    ).rejects.toThrow(/不属于该事件/);

    const count = await db.alert.count({ where: { incidentId } });
    expect(count).toBe(2);
  });

  it('已结案事件拒绝拆分', async () => {
    const ids = [
      await makeAlert('ACC-SW-05', 'LINK_DOWN', min(0)),
      await makeAlert('ACC-SW-05', 'PORT_FLAP', min(1)),
    ];
    const incidentId = await makeIncident(ids);
    await db.incident.update({
      where: { id: incidentId },
      data: { status: 'RESOLVED', resolvedAt: min(3) },
    });

    await expect(
      splitIncident({ idOrCode: incidentId, alertIds: [ids[0]!], now: min(5) }),
    ).rejects.toThrow(/已结案/);
  });

  it('拆分出的两个事件不会被下一轮聚合合并回去（splitFromId 守卫）', async () => {
    // 两台设备各 3 条告警：拆完后两边都覆盖 2 台设备、时间完全重叠，
    // 正好满足 B3 的合并条件 —— 如果没有 splitFromId 守卫，这一轮就会并回去。
    const ids = [
      await makeAlert('AGG-SW-03', 'LINK_DOWN', min(0)),
      await makeAlert('AGG-SW-03', 'PORT_FLAP', min(1)),
      await makeAlert('AGG-SW-03', 'CRC_ERROR', min(2)),
      await makeAlert('CORE-SW-01', 'LINK_DOWN', min(0)),
      await makeAlert('CORE-SW-01', 'PORT_FLAP', min(1)),
      await makeAlert('CORE-SW-01', 'CRC_ERROR', min(2)),
    ];
    const incidentId = await makeIncident(ids);

    const split = await splitIncident({
      idOrCode: incidentId,
      alertIds: [ids[2]!, ids[3]!],
      note: '这两条是另一处故障',
      now: min(5),
    });
    expect(split).not.toBeNull();

    const summary = await runCorrelation(min(6));
    expect(summary.merged).toHaveLength(0);

    const alive = await db.incident.count({
      where: { id: { in: [incidentId, split!.target.id] }, mergedIntoId: null },
    });
    expect(alive).toBe(2);
  });
});
