import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { loadTrends, metricRef, recordSamples, summarizeTrend } from './service';

const DEVICE = 'TEST-METRIC-DEV';
const hasDb = Boolean(process.env.DATABASE_URL);

describe('指标趋势（纯函数）', () => {
  it('线性上升得到正的每分钟斜率', () => {
    const trend = summarizeTrend([
      { at: '2026-11-20T10:00:00Z', value: 40 },
      { at: '2026-11-20T10:05:00Z', value: 50 },
      { at: '2026-11-20T10:10:00Z', value: 60 },
    ]);
    expect(trend).toMatchObject({
      samples: 3,
      first: 40,
      last: 60,
      min: 40,
      max: 60,
      slopePerMin: 2,
    });
  });

  it('乱序输入也按时间排序（上游推送不保证顺序）', () => {
    const trend = summarizeTrend([
      { at: '2026-11-20T10:10:00Z', value: 60 },
      { at: '2026-11-20T10:00:00Z', value: 40 },
    ]);
    expect(trend?.first).toBe(40);
    expect(trend?.last).toBe(60);
  });

  it('单点没有斜率，空集返回 null', () => {
    expect(summarizeTrend([{ at: '2026-11-20T10:00:00Z', value: 1 }])?.slopePerMin).toBe(0);
    expect(summarizeTrend([])).toBeNull();
  });

  it('ref 用设备名+指标名，模型引用可读', () => {
    expect(metricRef('CORE-SW-01', 'cpu.util')).toBe('metric:CORE-SW-01:cpu.util');
  });
});

describe.skipIf(!hasDb)('指标采样（依赖真实 DB）', () => {
  beforeAll(async () => {
    await db.device.upsert({
      where: { tenantId_name: { tenantId: 'default', name: DEVICE } },
      create: { name: DEVICE, type: 'SWITCH', layer: 3, site: '测试' },
      update: {},
    });
    await db.deviceAlias.upsert({
      where: { tenantId_alias: { tenantId: 'default', alias: 'test-metric-alias' } },
      create: {
        alias: 'test-metric-alias',
        tenantId: 'default',
        deviceId: (
          await db.device.findUniqueOrThrow({
            where: { tenantId_name: { tenantId: 'default', name: DEVICE } },
          })
        ).id,
        source: 'MANUAL',
      },
      update: {},
    });
    await db.metricSample.deleteMany({ where: { device: { name: DEVICE } } });
  });

  afterAll(async () => {
    await db.metricSample.deleteMany({ where: { device: { name: DEVICE } } });
    await db.deviceAlias.deleteMany({ where: { alias: 'test-metric-alias' } });
    await db.device.deleteMany({ where: { name: DEVICE } });
    await db.$disconnect();
  });

  it('别名解析 + 重复推送幂等（同一时刻同一来源只留一条）', async () => {
    const at = new Date('2026-11-20T02:00:00Z');
    const first = await recordSamples([
      { deviceName: 'test-metric-alias', metric: 'cpu.util', value: 55, at, unit: '%' },
    ]);
    expect(first.accepted).toBe(1);

    const second = await recordSamples([
      { deviceName: 'test-metric-alias', metric: 'cpu.util', value: 99, at, unit: '%' },
    ]);
    expect(second.accepted).toBe(0);
    expect(second.skipped).toBe(1);

    const rows = await db.metricSample.findMany({ where: { device: { name: DEVICE } } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.value).toBe(55); // 重推不覆盖已有采样
  });

  it('未知设备只跳过，不抛异常', async () => {
    const result = await recordSamples([
      { deviceName: 'NO-SUCH-DEV', metric: 'cpu.util', value: 1, at: new Date() },
    ]);
    expect(result.accepted).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.issues[0]?.message).toContain('设备不存在');
  });

  it('loadTrends 按 设备+指标 分组并算出趋势', async () => {
    const device = await db.device.findUniqueOrThrow({
      where: { tenantId_name: { tenantId: 'default', name: DEVICE } },
    });
    const base = Date.parse('2026-11-20T03:00:00Z');
    await recordSamples(
      [0, 5, 10].map((minute, index) => ({
        deviceName: DEVICE,
        metric: 'link.in_bps',
        value: 100 + index * 20,
        at: new Date(base + minute * 60_000),
      })),
    );

    const trends = await loadTrends(
      [device.id],
      new Date(base - 60_000),
      new Date(base + 3600_000),
    );
    const trend = trends.get(`${device.id}|link.in_bps`);
    expect(trend).toBeDefined();
    expect(trend!.samples).toBe(3);
    expect(trend!.first).toBe(100);
    expect(trend!.last).toBe(140);
    expect(trend!.slopePerMin).toBe(4);
  });
});
