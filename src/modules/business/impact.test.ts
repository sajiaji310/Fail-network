import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { getAffectedServices, mapAffectedServicesByDevice, mergeServices } from './impact';

/**
 * 业务影响面（评审第 3 阶段）。
 *
 * 口径：受影响服务 = 事件设备 ∩ 服务依赖设备。测试用单独的 TEST- 前缀服务，
 * 不碰种子里的门户/支付等真实服务，避免和演示数据互相干扰。
 */

async function makeService(
  code: string,
  tier: number,
  deviceNames: readonly string[],
): Promise<string> {
  const service = await db.service.create({
    data: { code, name: `${code} 服务`, tier, owner: '测试' },
    select: { id: true },
  });
  const devices = await db.device.findMany({
    where: { name: { in: [...deviceNames] } },
    select: { id: true },
  });
  await db.serviceDevice.createMany({
    data: devices.map((d) => ({ serviceId: service.id, deviceId: d.id, role: 'ACCESS' })),
  });
  return service.id;
}

async function cleanup() {
  await db.service.deleteMany({ where: { code: { startsWith: 'TEST-' } } });
}

beforeEach(cleanup);
afterAll(cleanup);

describe('getAffectedServices', () => {
  it('命中的服务按关键级别排序，带上命中设备', async () => {
    await makeService('TEST-MINOR', 3, ['ACC-SW-01']);
    await makeService('TEST-CRIT', 1, ['ACC-SW-01', 'AGG-SW-01']);

    const devices = await db.device.findMany({
      where: { name: { in: ['ACC-SW-01', 'AGG-SW-01'] } },
      select: { id: true },
    });
    const result = await getAffectedServices(devices.map((d) => d.id));

    const mine = result.filter((s) => s.code.startsWith('TEST-'));
    expect(mine.map((s) => s.code)).toEqual(['TEST-CRIT', 'TEST-MINOR']);
    expect(mine[0]!.hitDevices.sort()).toEqual(['ACC-SW-01', 'AGG-SW-01']);
    expect(mine[1]!.hitDevices).toEqual(['ACC-SW-01']);
  });

  it('只命中一台设备时也只报一台，不把服务依赖的全部设备算成受影响', async () => {
    await makeService('TEST-MULTI', 2, ['ACC-SW-01', 'ACC-SW-02', 'ACC-SW-03']);
    const device = await db.device.findUniqueOrThrow({
      where: { tenantId_name: { tenantId: 'default', name: 'ACC-SW-02' } },
      select: { id: true },
    });

    const result = await getAffectedServices([device.id]);
    const mine = result.find((s) => s.code === 'TEST-MULTI')!;
    expect(mine.hitDevices).toEqual(['ACC-SW-02']);
  });

  it('没有设备时直接返回空，不查库', async () => {
    expect(await getAffectedServices([])).toEqual([]);
  });
});

describe('mapAffectedServicesByDevice / mergeServices', () => {
  it('批量查询按设备分组，合并时同一服务只留一条', async () => {
    await makeService('TEST-BATCH', 2, ['ACC-SW-04', 'ACC-SW-05']);
    const devices = await db.device.findMany({
      where: { name: { in: ['ACC-SW-04', 'ACC-SW-05'] } },
      select: { id: true },
    });

    const map = await mapAffectedServicesByDevice(devices.map((d) => d.id));
    expect(map.size).toBe(2);

    const merged = mergeServices(devices.map((d) => map.get(d.id) ?? [])).filter((s) =>
      s.code.startsWith('TEST-'),
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]!.hitDevices.sort()).toEqual(['ACC-SW-04', 'ACC-SW-05']);
  });
});
