import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { runRetention, type RetentionPolicy } from './retention';

const DEVICE = 'TEST-RETENTION-DEV';
const ACTOR = 'test-retention';
const PREFIX = 'TEST-RETENTION-';
const hasDb = Boolean(process.env.DATABASE_URL);
const NOW = new Date('2026-11-20T00:00:00Z');

const POLICY: RetentionPolicy = {
  metricDays: 30,
  auditDays: 180,
  batchDays: 30,
  closedIncidentDays: 0,
};

const daysAgo = (days: number) => new Date(NOW.getTime() - days * 24 * 3600_000);

describe.skipIf(!hasDb)('数据保留策略（依赖真实 DB）', () => {
  beforeAll(async () => {
    await db.device.upsert({
      where: { name: DEVICE },
      create: { name: DEVICE, type: 'SWITCH', layer: 3, site: '测试' },
      update: {},
    });
    const device = await db.device.findUniqueOrThrow({ where: { name: DEVICE } });

    await db.metricSample.deleteMany({ where: { deviceId: device.id } });
    await db.metricSample.createMany({
      data: [
        { deviceId: device.id, metric: 'cpu.util', value: 1, at: daysAgo(90), source: PREFIX },
        { deviceId: device.id, metric: 'cpu.util', value: 2, at: daysAgo(1), source: PREFIX },
      ],
    });

    await db.auditLog.deleteMany({ where: { actor: ACTOR } });
    await db.auditLog.createMany({
      data: [
        { action: 'analyze.run', actor: ACTOR, result: 'OK', at: daysAgo(200) },
        { action: 'analyze.run', actor: ACTOR, result: 'OK', at: daysAgo(2) },
      ],
    });

    await db.ingestBatch.deleteMany({ where: { source: { startsWith: PREFIX } } });
    await db.ingestBatch.createMany({
      data: [
        {
          source: `${PREFIX}old`,
          kind: 'json',
          status: 'DONE',
          total: 10,
          processed: 10,
          createdAt: daysAgo(60),
        },
        {
          source: `${PREFIX}new`,
          kind: 'json',
          status: 'DONE',
          total: 10,
          processed: 10,
          createdAt: daysAgo(1),
        },
      ],
    });
  });

  afterAll(async () => {
    const device = await db.device.findUnique({ where: { name: DEVICE } });
    if (device) {
      await db.metricSample.deleteMany({ where: { deviceId: device.id } });
      await db.device.delete({ where: { id: device.id } });
    }
    await db.auditLog.deleteMany({ where: { actor: ACTOR } });
    await db.ingestBatch.deleteMany({ where: { source: { startsWith: PREFIX } } });
    await db.$disconnect();
  });

  it('dryRun 只统计不删除', async () => {
    const report = await runRetention({ dryRun: true, now: NOW, policy: POLICY });
    expect(report.dryRun).toBe(true);
    expect(report.deleted.metrics).toBeGreaterThanOrEqual(1);
    expect(report.deleted.audit).toBeGreaterThanOrEqual(1);
    expect(report.deleted.batches).toBeGreaterThanOrEqual(1);
    expect(report.deleted.incidents).toBe(0);

    // 数据还在
    const samples = await db.metricSample.count({ where: { device: { name: DEVICE } } });
    expect(samples).toBe(2);
    const audits = await db.auditLog.count({ where: { actor: ACTOR } });
    expect(audits).toBe(2);
  });

  it('真删只清过期数据，窗口内的保留', async () => {
    const report = await runRetention({ dryRun: false, now: NOW, policy: POLICY });
    expect(report.deleted.metrics).toBe(1);
    expect(report.deleted.audit).toBe(1);
    expect(report.deleted.batches).toBe(1);

    const samples = await db.metricSample.count({ where: { device: { name: DEVICE } } });
    expect(samples).toBe(1);
    const audits = await db.auditLog.count({ where: { actor: ACTOR } });
    expect(audits).toBe(1);
    const batches = await db.ingestBatch.findMany({ where: { source: { startsWith: PREFIX } } });
    expect(batches).toHaveLength(1);
    expect(batches[0]!.source).toBe(`${PREFIX}new`);
  });

  it('closedIncidentDays=0 表示不清理事件（MTTR 的事实源不能删）', async () => {
    const report = await runRetention({ dryRun: true, now: NOW, policy: POLICY });
    expect(report.cutoffs.incidents).toBeNull();
    expect(report.deleted.incidents).toBe(0);
  });
});
