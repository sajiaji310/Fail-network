import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { signatureOf } from '../alerts/fingerprint';
import { ANALYSIS_CACHE_MS, runAnalysis } from './analyze';
import { parseAnalysisMeta } from './schema';

/**
 * 研判编排集成测试（AC-07 降级 + 落库 + 5 分钟缓存）。
 *
 * 跑真实数据库，用**过去的基准时间**隔离：这次是 2026-11-11 03:00，
 * 与 T05 集成测试（11-10 02:00）错开，互不干扰。
 * .env 里 LLM_API_KEY 为空 → 必然走 RULE_FALLBACK，正好验收"无 key 全链路可用"。
 */

const BASE = new Date('2026-11-11T03:00:00Z');
const at = (minutes: number) => new Date(BASE.getTime() + minutes * 60_000);

let incidentId = '';
let changeId = '';
let alertSeq = 0;

async function alertFor(
  deviceName: string,
  type: string,
  severity: 'P0' | 'P1' | 'P2',
  minutes: number,
) {
  const device = await db.device.findUnique({ where: { name: deviceName }, select: { id: true } });
  if (!device) throw new Error(`设备不存在：${deviceName}，先跑 npm run db:seed`);
  const signature = signatureOf(device.id, type, null);
  const fingerprint = await db.alertFingerprint.upsert({
    where: { signature },
    create: { signature, deviceId: device.id, type, severity },
    update: {},
  });
  alertSeq++;
  return db.alert.create({
    data: {
      fingerprintId: fingerprint.id,
      severity,
      message: `${deviceName} ${type}`,
      firstSeen: at(minutes),
      lastSeen: at(minutes),
      cycleStart: at(minutes),
      externalKey: `T07-${Date.now()}-${alertSeq}`,
      incidentId,
    },
    select: { id: true },
  });
}

beforeAll(async () => {
  const agg = await db.device.findUnique({ where: { name: 'AGG-SW-02' }, select: { id: true } });
  if (!agg) throw new Error('种子数据缺失，先跑 npm run db:seed');

  const incident = await db.incident.create({
    data: {
      code: `INC-T07-${Date.now()}`,
      title: 'AGG-SW-02 线卡故障（T07 集成测试）',
      severity: 'P1',
      status: 'OPEN',
      startedAt: at(0),
      lastSeen: at(12),
      clusterKey: `t07-${Date.now()}`,
    },
    select: { id: true },
  });
  incidentId = incident.id;

  await alertFor('AGG-SW-02', 'LINECARD_FAILURE', 'P0', 0);
  await alertFor('AGG-SW-02', 'DEVICE_UNREACHABLE', 'P0', 7);
  await alertFor('ACC-SW-07', 'LINK_DOWN', 'P1', 1);

  const change = await db.changeRecord.create({
    data: {
      deviceId: agg.id,
      kind: 'CONFIG',
      content: 'T07 测试：线卡槽位配置变更',
      operator: '测试',
      changedAt: at(-30),
    },
    select: { id: true },
  });
  changeId = change.id;
});

afterAll(async () => {
  await db.alert.deleteMany({ where: { incidentId } });
  await db.incident.deleteMany({ where: { id: incidentId } });
  await db.changeRecord.deleteMany({ where: { id: changeId } });
});

describe('runAnalysis 降级路径（AC-07）', () => {
  it('无 LLM key 时返回 RULE_FALLBACK 且至少 1 条假设', async () => {
    const outcome = await runAnalysis(incidentId, { force: true });
    expect(outcome).not.toBeNull();
    expect(outcome?.source).toBe('RULE_FALLBACK');
    expect(outcome?.cached).toBe(false);
    expect(outcome?.hypotheses.length).toBeGreaterThan(0);
    expect(outcome?.degradedReason).toContain('LLM_API_KEY');
  });

  it('证据引用全部命中库内真实 id（AC-06 正向）', async () => {
    const outcome = await runAnalysis(incidentId, { force: true });
    const evidence = outcome?.hypotheses.flatMap((h) => h.evidence) ?? [];
    expect(evidence.length).toBeGreaterThan(0);

    for (const item of evidence) {
      if (item.type === 'ALERT') {
        expect(await db.alert.count({ where: { id: item.ref } })).toBe(1);
      } else if (item.type === 'CHANGE') {
        expect(await db.changeRecord.count({ where: { id: item.ref } })).toBe(1);
      } else if (item.type === 'TOPOLOGY') {
        expect(await db.topologyLink.count({ where: { id: item.ref } })).toBe(1);
      } else {
        expect(await db.caseRecord.count({ where: { id: item.ref } })).toBe(1);
      }
    }
  });

  it('结论与审计元数据落库', async () => {
    await runAnalysis(incidentId, { force: true });
    const row = await db.incident.findUnique({
      where: { id: incidentId },
      select: {
        summary: true,
        impactScope: true,
        analysisMeta: true,
        hypotheses: { orderBy: { rank: 'asc' }, select: { rank: true, source: true } },
      },
    });
    expect(row?.summary).toBeTruthy();
    expect(row?.impactScope).toBeTruthy();
    expect(row?.hypotheses.length).toBeGreaterThan(0);
    expect(row?.hypotheses.every((h) => h.source === 'RULE_FALLBACK')).toBe(true);

    const meta = parseAnalysisMeta(row?.analysisMeta);
    expect(meta?.source).toBe('RULE_FALLBACK');
    expect(meta?.promptVersion).toBeTruthy();
    expect(meta?.verify.stats.rawEvidence).toBeGreaterThan(0);
  });

  it('重跑是整体替换而不是追加（不会出现两轮结论并存）', async () => {
    await runAnalysis(incidentId, { force: true });
    const first = await db.hypothesis.count({ where: { incidentId } });
    await runAnalysis(incidentId, { force: true });
    const second = await db.hypothesis.count({ where: { incidentId } });
    expect(second).toBe(first);
    const ranks = await db.hypothesis.findMany({
      where: { incidentId },
      orderBy: { rank: 'asc' },
      select: { rank: true },
    });
    expect(ranks.map((r) => r.rank)).toEqual(ranks.map((_, index) => index + 1));
  });
});

describe('幂等与缓存', () => {
  it('5 分钟内重复调用命中缓存，不重算也不新增假设', async () => {
    await runAnalysis(incidentId, { force: true });
    const before = await db.hypothesis.count({ where: { incidentId } });

    const cached = await runAnalysis(incidentId);
    expect(cached?.cached).toBe(true);
    expect(cached?.hypotheses.length).toBe(before);
  });

  it('force 跳过缓存', async () => {
    await runAnalysis(incidentId, { force: true });
    const fresh = await runAnalysis(incidentId, { force: true });
    expect(fresh?.cached).toBe(false);
  });

  it('缓存窗口是 5 分钟（文档 10.4）', () => {
    expect(ANALYSIS_CACHE_MS).toBe(5 * 60 * 1000);
  });
});

describe('边界', () => {
  it('事件不存在返回 null（由 route 转 404）', async () => {
    expect(await runAnalysis('INC-NOT-EXIST-T07')).toBeNull();
  });
});
