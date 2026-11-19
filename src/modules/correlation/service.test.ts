import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { signatureOf } from '../alerts/fingerprint';
import { buildDeviceGraph } from './topology';
import { runCorrelation } from './service';

/**
 * 集成测试：跑真实数据库。
 * 关键手法——用**过去的基准时间**（2026-11-10）+ `runCorrelation(now)`，
 * 让聚合只看到本用例写入的告警，不受库里当前演示数据影响。
 */

const BASE = new Date('2026-11-10T02:00:00Z');
const min = (n: number) => new Date(BASE.getTime() + n * 60_000);

let alertSeq = 0;
const deviceCache = new Map<string, { id: string; name: string }>();

async function device(name: string) {
  const cached = deviceCache.get(name);
  if (cached) return cached;
  const row = await db.device.findUnique({ where: { name }, select: { id: true, name: true } });
  if (!row) throw new Error(`设备不存在：${name}`);
  deviceCache.set(name, row);
  return row;
}

type AlertOpts = { metric?: string; severity?: 'P0' | 'P1' | 'P2' | 'P3' };

async function makeAlert(
  deviceName: string,
  type: string,
  at: Date,
  opts: AlertOpts = {},
): Promise<string> {
  const dev = await device(deviceName);
  const metric = opts.metric ?? null;
  const signature = signatureOf(dev.id, type, metric);
  const fingerprint = await db.alertFingerprint.upsert({
    where: { signature },
    create: { signature, deviceId: dev.id, type, metric, severity: opts.severity ?? 'P2' },
    update: {},
  });
  alertSeq++;
  const row = await db.alert.create({
    data: {
      fingerprintId: fingerprint.id,
      severity: opts.severity ?? 'P2',
      message: `${deviceName} ${type}`,
      firstSeen: at,
      lastSeen: at,
      cycleStart: at,
      externalKey: `T05-${alertSeq}`,
      status: 'ACTIVE',
    },
    select: { id: true },
  });
  return row.id;
}

async function makeClusterAlerts(deviceName: string, base: Date, types: string[], tag: string) {
  const ids: string[] = [];
  for (const [i, type] of types.entries()) {
    ids.push(
      await makeAlert(deviceName, type, new Date(base.getTime() + i * 30_000), { metric: tag }),
    );
  }
  return ids;
}

async function incidentOf(alertIds: readonly string[]): Promise<string[]> {
  const rows = await db.alert.findMany({
    where: { id: { in: [...alertIds] } },
    select: { incidentId: true },
  });
  return [...new Set(rows.map((r) => r.incidentId).filter((id): id is string => !!id))].sort();
}

async function resetTestData() {
  await db.alert.deleteMany({ where: { externalKey: { startsWith: 'T05-' } } });
  await db.incident.deleteMany({
    where: {
      clusterKey: { not: null },
      startedAt: { gte: new Date('2026-11-09T00:00:00Z'), lte: new Date('2026-11-12T00:00:00Z') },
    },
  });
}

beforeEach(resetTestData);
// 收尾也要清：性能用例会灌 500 条告警，留着会污染演示数据与概览页
afterAll(resetTestData);

describe('AC-03 / AC-04 / AC-17 成簇与幂等', () => {
  it('3 条同设备告警 → 1 个事件；重跑不新建、id 完全一致', async () => {
    const ids = await makeClusterAlerts(
      'ACC-SW-01',
      BASE,
      ['LINK_DOWN', 'PACKET_LOSS', 'CPU_HIGH'],
      'ac03',
    );

    const first = await runCorrelation(min(10));
    expect(first.created).toHaveLength(1);
    const incidentId = first.created[0]!.id;
    expect(first.created[0]!.alerts).toBe(3);

    const second = await runCorrelation(min(10));
    expect(second.created).toHaveLength(0);

    const after = await incidentOf(ids);
    expect(after).toEqual([incidentId]);
    expect(second.updated).toHaveLength(0);
    expect(second.reopened).toHaveLength(0);
  });

  it('只有 2 条告警不成事件（防噪声），但会留在库里', async () => {
    const ids = await makeClusterAlerts('ACC-SW-02', BASE, ['LINK_DOWN', 'PACKET_LOSS'], 'ac03b');
    const result = await runCorrelation(min(10));
    expect(result.created).toHaveLength(0);
    expect(result.noiseAlerts).toBe(2);
    expect(await incidentOf(ids)).toEqual([]);
  });
});

describe('AC-15 跨窗口沿用同一事件', () => {
  it('20 分钟后的同类型告警挂到原事件，lastSeen 延长', async () => {
    const first = await makeClusterAlerts(
      'ACC-SW-03',
      BASE,
      ['LINK_DOWN', 'PORT_FLAP', 'CRC_ERROR'],
      'ac15',
    );
    const created = await runCorrelation(min(10));
    expect(created.created).toHaveLength(1);
    const incidentId = created.created[0]!.id;

    // 超出 5 分钟窗口，但同设备同族 → B5 沿用它
    const later = await makeAlert('ACC-SW-03', 'LINK_DOWN', min(25), { metric: 'ac15-late' });
    const second = await runCorrelation(min(25));

    expect(second.created).toHaveLength(0);
    expect(second.updated.map((u) => u.id)).toEqual([incidentId]);

    const incident = await db.incident.findUnique({ where: { id: incidentId } });
    expect(incident?.lastSeen.toISOString()).toBe(min(25).toISOString());

    expect(await incidentOf([...first, later])).toEqual([incidentId]);
  });
});

describe('AC-16 / B7 并发故障不合并', () => {
  it('两个簇相距 3 跳且时间重叠 → 生成 2 个事件', async () => {
    // 从真实拓扑里找一对 > 2 跳的接入交换机，避免硬编码种子拓扑
    const links = await db.topologyLink.findMany({ select: { sourceId: true, targetId: true } });
    const graph = buildDeviceGraph(links);
    const access = await db.device.findMany({
      where: { name: { startsWith: 'ACC-SW-' } },
      select: { id: true, name: true },
    });

    let farA: { id: string; name: string } | null = null;
    let farB: { id: string; name: string } | null = null;
    for (let i = 0; i < access.length && !farB; i++) {
      for (let j = i + 1; j < access.length; j++) {
        if (graph.hop(access[i]!.id, access[j]!.id) > 2) {
          farA = access[i]!;
          farB = access[j]!;
          break;
        }
      }
    }
    expect(farA && farB).toBeTruthy();

    await makeClusterAlerts(farA!.name, BASE, ['LINK_DOWN', 'PORT_FLAP', 'CRC_ERROR'], 'b7-a');
    await makeClusterAlerts(farB!.name, BASE, ['LINK_DOWN', 'PORT_FLAP', 'CRC_ERROR'], 'b7-b');

    const result = await runCorrelation(min(10));
    expect(result.created).toHaveLength(2);
    expect(result.merged).toHaveLength(0);
  });
});

describe('B6 结案后再发生', () => {
  it('30 分钟内同簇再现 → 重开原事件，reopenedCount+1', async () => {
    const firstIds = await makeClusterAlerts(
      'ACC-SW-04',
      BASE,
      ['LINK_DOWN', 'PORT_FLAP', 'CRC_ERROR'],
      'b6a',
    );
    const created = await runCorrelation(min(10));
    const incidentId = created.created[0]!.id;

    await db.incident.update({
      where: { id: incidentId },
      data: { status: 'RESOLVED', resolvedAt: min(12), mttrSeconds: 720 },
    });

    const againIds = await makeClusterAlerts(
      'ACC-SW-04',
      min(20),
      ['LINK_DOWN', 'PORT_FLAP', 'CRC_ERROR'],
      'b6a-again',
    );
    const second = await runCorrelation(min(30));

    expect(second.reopened).toHaveLength(1);
    expect(second.reopened[0]!.id).toBe(incidentId);
    expect(second.reopened[0]!.reopenedCount).toBe(1);
    expect(second.created).toHaveLength(0);

    const incident = await db.incident.findUnique({ where: { id: incidentId } });
    expect(incident?.status).toBe('OPEN');
    expect(incident?.resolvedAt).toBeNull();
    expect(await incidentOf([...firstIds, ...againIds])).toEqual([incidentId]);
  });

  it('超过 30 分钟同簇再现 → 新建事件并指向旧事件（reopenedFromId）', async () => {
    await makeClusterAlerts('ACC-SW-05', BASE, ['LINK_DOWN', 'PORT_FLAP', 'CRC_ERROR'], 'b6b');
    const created = await runCorrelation(min(10));
    const oldId = created.created[0]!.id;

    await db.incident.update({
      where: { id: oldId },
      data: { status: 'RESOLVED', resolvedAt: min(12), mttrSeconds: 720 },
    });

    await makeClusterAlerts(
      'ACC-SW-05',
      min(90),
      ['LINK_DOWN', 'PORT_FLAP', 'CRC_ERROR'],
      'b6b-new',
    );
    const second = await runCorrelation(min(100));

    expect(second.created).toHaveLength(1);
    const newId = second.created[0]!.id;
    expect(newId).not.toBe(oldId);

    const fresh = await db.incident.findUnique({ where: { id: newId } });
    expect(fresh?.reopenedFromId).toBe(oldId);
    expect(fresh?.reopenedCount).toBe(0);
  });
});

describe('B3 事件级合并', () => {
  it('两个事件共享 2 台设备且时间重叠 → 合并并写 mergedIntoId', async () => {
    const aAlerts = [
      await makeAlert('ACC-SW-06', 'LINK_DOWN', min(0), { metric: 'b3' }),
      await makeAlert('ACC-SW-07', 'PACKET_LOSS', min(1), { metric: 'b3' }),
      await makeAlert('ACC-SW-06', 'CPU_HIGH', min(2), { metric: 'b3' }),
    ];
    const bAlerts = [
      await makeAlert('ACC-SW-06', 'HIGH_LATENCY', min(3), { metric: 'b3' }),
      await makeAlert('ACC-SW-07', 'JITTER_HIGH', min(4), { metric: 'b3' }),
      await makeAlert('ACC-SW-07', 'DNS_TIMEOUT', min(5), { metric: 'b3' }),
    ];

    const codeA = 'INC-20261110-801';
    const codeB = 'INC-20261110-802';
    const a = await db.incident.create({
      data: {
        code: codeA,
        title: 'B3 测试事件 A',
        status: 'OPEN',
        severity: 'P2',
        startedAt: min(0),
        lastSeen: min(10),
        clusterKey: 'b3-key-a',
      },
    });
    const b = await db.incident.create({
      data: {
        code: codeB,
        title: 'B3 测试事件 B',
        status: 'OPEN',
        severity: 'P2',
        startedAt: min(1),
        lastSeen: min(9),
        clusterKey: 'b3-key-b',
      },
    });
    await db.alert.updateMany({ where: { id: { in: aAlerts } }, data: { incidentId: a.id } });
    await db.alert.updateMany({ where: { id: { in: bAlerts } }, data: { incidentId: b.id } });

    const result = await runCorrelation(min(10));
    expect(result.merged).toHaveLength(1);

    const keeper = await db.incident.findUnique({ where: { code: codeA } });
    const dropped = await db.incident.findUnique({ where: { code: codeB } });
    expect(keeper?.status).toBe('OPEN');
    expect(dropped?.status).toBe('CLOSED');
    expect(dropped?.closedReason).toBe('AUTO_MERGED');
    expect(dropped?.mergedIntoId).toBe(keeper!.id);
    expect(await incidentOf([...aAlerts, ...bAlerts])).toEqual([keeper!.id]);
  });
});

describe('回归：聚合时刻之后的告警不能当锚点', () => {
  it('库中存在更晚的事件时，当前批告警必须新建事件而不是并进去', async () => {
    const futureAt = min(60);
    const futureIds = await makeClusterAlerts(
      'ACC-SW-08',
      futureAt,
      ['LINK_DOWN', 'PORT_FLAP', 'CRC_ERROR'],
      'future',
    );

    const futureIncident = await db.incident.create({
      data: {
        code: 'INC-20261110-900',
        title: '未来事件（模拟时钟偏差/后续补报）',
        status: 'OPEN',
        severity: 'P2',
        startedAt: futureAt,
        lastSeen: futureAt,
        clusterKey: 'future-key',
      },
    });
    await db.alert.updateMany({
      where: { id: { in: futureIds } },
      data: { incidentId: futureIncident.id },
    });

    const nowIds = await makeClusterAlerts(
      'ACC-SW-08',
      BASE,
      ['LINK_DOWN', 'PORT_FLAP', 'CRC_ERROR'],
      'now',
    );

    const result = await runCorrelation(min(10));
    expect(result.created).toHaveLength(1);
    expect(result.created[0]!.id).not.toBe(futureIncident.id);

    const untouched = await db.incident.findUnique({ where: { id: futureIncident.id } });
    expect(untouched?.startedAt.toISOString()).toBe(futureAt.toISOString());
    expect(await incidentOf(nowIds)).toEqual([result.created[0]!.id]);
  });
});

describe('AC-11 聚合性能', () => {
  it('500 条告警入库后执行聚合 < 2s（含数据库往返）', async () => {
    const devices = await db.device.findMany({
      where: { name: { startsWith: 'ACC-SW-' } },
      select: { id: true },
      take: 25,
    });
    expect(devices.length).toBe(25);

    const types = ['LINK_DOWN', 'PACKET_LOSS', 'CPU_HIGH'];
    const fingerprints: Array<{ id: string; type: string }> = [];
    for (const [i, dev] of devices.entries()) {
      for (const type of types) {
        const metric = `perf-${i}-${type}`;
        const signature = signatureOf(dev.id, type, metric);
        const fp = await db.alertFingerprint.upsert({
          where: { signature },
          create: { signature, deviceId: dev.id, type, metric, severity: 'P3' },
          update: {},
        });
        fingerprints.push({ id: fp.id, type });
      }
    }

    const rows: Array<{
      fingerprintId: string;
      severity: 'P3';
      message: string;
      firstSeen: Date;
      lastSeen: Date;
      cycleStart: Date;
      externalKey: string;
      status: 'ACTIVE';
    }> = [];
    for (let n = 0; n < 500; n++) {
      const fp = fingerprints[n % fingerprints.length]!;
      // 每条错开 1 秒：同指纹同 cycleStart 会撞唯一键
      const at = new Date(BASE.getTime() + n * 1000);
      alertSeq++;
      rows.push({
        fingerprintId: fp.id,
        severity: 'P3',
        message: `perf ${n}`,
        firstSeen: at,
        lastSeen: at,
        cycleStart: at,
        externalKey: `T05-PERF-${alertSeq}`,
        status: 'ACTIVE',
      });
    }
    const created = await db.alert.createMany({ data: rows });

    const start = performance.now();
    const result = await runCorrelation(min(40));
    const elapsed = performance.now() - start;

    expect(created.count).toBe(500);
    expect(result.consideredAlerts).toBe(500);
    expect(elapsed).toBeLessThan(2000);
  });
});
