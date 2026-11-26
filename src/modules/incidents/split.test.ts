import type { DeviceType } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { signatureOf } from '@/modules/alerts/fingerprint';
import { runCorrelation } from '@/modules/correlation/service';
import { splitIncident } from './split';

/**
 * 拆分集成测试：真库 + 固定历史时间。
 * 验证四件事：告警归属、两边聚合重算、拆分留痕（statusLog + splitFromId）、
 * 以及拆出来的两个事件不会被下一轮聚合合并回去。
 *
 * 为什么整份文件必须待在专属租户（别改回 default）：
 * `runCorrelation` 的事件级合并阶段（correlation/service.ts:441-447）捞的是该租户
 * 全部 ACTIVE 事件、且**不带任何时间过滤**，再两两跑 checkMergeable。用例一旦建在
 * default 租户、还用 AGG-SW-03 / CORE-SW-01 这类真实设备名，同一轮的合并判定就会把
 * 演示数据、评测残留、其它用例遗留的 ACTIVE 事件一起卷进来 —— 断言结果于是取决于
 * 跑的时候库里有什么，表现为"单跑绿、全量偶红"。独立租户后，租户内只有本文件的
 * 设备与事件，合并结果只由本用例决定。
 */

const TENANT = 'split-test';

const BASE = new Date('2026-11-11T02:00:00Z');
const min = (n: number) => new Date(BASE.getTime() + n * 60_000);

let seq = 0;

/**
 * 在专属租户里建（或复用）设备，返回 deviceId。
 *
 * 设备类型与层级从 default 租户的同名设备照抄 —— 枚举值必须是真的，
 * 按设备名前缀猜 `DeviceType` 会写出跑得通但语义错的夹具。库里没种过数据
 * 时才退回按命名惯例推断层级（CORE=1 汇聚=2 接入=3），类型按交换机。
 */
async function ensureDevice(name: string): Promise<string> {
  const template = await db.device.findUnique({
    where: { tenantId_name: { tenantId: 'default', name } },
    select: { type: true, layer: true },
  });
  const fallbackLayer = name.startsWith('CORE') ? 1 : name.startsWith('AGG') ? 2 : 3;
  const device = await db.device.upsert({
    where: { tenantId_name: { tenantId: TENANT, name } },
    create: {
      tenantId: TENANT,
      name,
      type: (template?.type ?? 'SWITCH') as DeviceType,
      layer: template?.layer ?? fallbackLayer,
    },
    // 已存在就不动：一个文件里多个用例复用同一台设备，重复跑不能互相翻属性
    update: {},
    select: { id: true },
  });
  return device.id;
}

async function makeAlert(deviceName: string, type: string, at: Date): Promise<string> {
  const deviceId = await ensureDevice(deviceName);
  const metric = `split-test`;
  const signature = signatureOf(deviceId, type, metric);
  const fingerprint = await db.alertFingerprint.upsert({
    where: { signature },
    create: { signature, deviceId, type, metric, severity: 'P1' },
    update: {},
  });
  seq++;
  const row = await db.alert.create({
    data: {
      fingerprintId: fingerprint.id,
      // 必须显式写：默认值是 "default"，漏了这一步告警会落回默认租户，隔离当场失效
      tenantId: TENANT,
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
      tenantId: TENANT,
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

/** 每个用例前清空本租户的告警与事件；default 租户一个字节都不碰 */
async function cleanup() {
  await db.alert.deleteMany({ where: { tenantId: TENANT } });
  await db.incident.deleteMany({ where: { tenantId: TENANT } });
}

/**
 * 收尾时把设备与指纹也删掉。
 *
 * 设备本身可以留在租户里保证幂等，但本文件用的是 AGG-SW-03 / ACC-SW-01 这类
 * **真实设备名**，留着会让其它用例的"按名字前缀取样"多出跨租户同名设备
 * （例如 correlation/service.test.ts 拿 `name startsWith 'ACC-SW-'` 建图，
 * 多出来的无链路影子设备会把"相距 > 2 跳"的取样带偏）。租户隔离只解决事件合并，
 * 解决不了别人按名字查设备，所以这里一并清干净。
 */
async function teardown() {
  await cleanup();
  await db.alertFingerprint.deleteMany({ where: { device: { tenantId: TENANT } } });
  await db.device.deleteMany({ where: { tenantId: TENANT } });
}

beforeEach(cleanup);
afterAll(teardown);

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
      tenantId: TENANT,
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
      splitIncident({ idOrCode: incidentId, alertIds: ids, now: min(5), tenantId: TENANT }),
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
      splitIncident({ idOrCode: incidentId, alertIds: [stranger], now: min(5), tenantId: TENANT }),
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
      splitIncident({ idOrCode: incidentId, alertIds: [ids[0]!], now: min(5), tenantId: TENANT }),
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
      tenantId: TENANT,
    });
    expect(split).not.toBeNull();

    // 租户内此刻只有这一对事件，合并判定的输入完全由本用例决定
    const summary = await runCorrelation(min(6), TENANT);
    expect(summary.merged).toHaveLength(0);

    const alive = await db.incident.count({
      where: { id: { in: [incidentId, split!.target.id] }, mergedIntoId: null },
    });
    expect(alive).toBe(2);
  });
});
