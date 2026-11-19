import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { IncidentStatus } from '@prisma/client';
import { db } from '@/lib/db';
import { signatureOf } from '@/modules/alerts/fingerprint';
import { getIncidentDetail } from './detail';
import { setHypothesisVerdict, transitionIncident } from './lifecycle';

/**
 * 集成测试：人工确认与结案（T08 / AC-08 / AC-09）。
 *
 * 隔离手法与 T05 一致：事件编码统一 `T08-INC-` 前缀，告警 externalKey 统一 `T08-A-`，
 * 前后各自清理，绝不删演示数据。设备复用 seed 里的 ACC-SW-01（不新建）。
 */

const CODE_PREFIX = 'T08-INC-';
const ALERT_PREFIX = 'T08-A-';
const BASE = new Date('2026-01-05T10:00:00Z');

let seq = 0;
const min = (n: number) => new Date(BASE.getTime() + n * 60_000);

async function cleanup() {
  await db.alert.deleteMany({ where: { externalKey: { startsWith: ALERT_PREFIX } } });
  await db.incident.deleteMany({ where: { code: { startsWith: CODE_PREFIX } } });
}

beforeEach(cleanup);
afterAll(cleanup);

async function createIncident(
  options: { startedAt?: Date; status?: IncidentStatus } = {},
): Promise<{ id: string; code: string }> {
  seq += 1;
  const startedAt = options.startedAt ?? BASE;
  const device = await db.device.findFirstOrThrow({
    where: { name: 'ACC-SW-01' },
    select: { id: true },
  });
  const signature = signatureOf(device.id, 'LINK_DOWN', 't08');
  const fingerprint = await db.alertFingerprint.upsert({
    where: { signature },
    create: {
      signature,
      deviceId: device.id,
      type: 'LINK_DOWN',
      metric: 't08',
      severity: 'P2',
    },
    update: {},
  });

  const incident = await db.incident.create({
    data: {
      code: `${CODE_PREFIX}${seq}`,
      title: 'T08 测试事件',
      status: options.status ?? 'OPEN',
      severity: 'P2',
      startedAt,
      lastSeen: startedAt,
      clusterKey: `T08-KEY-${seq}-${Date.now()}`,
    },
    select: { id: true, code: true },
  });

  // cycleStart 参与唯一约束 [fingerprintId, cycleStart]：同用例内多次建事件时错开
  const cycleStart = new Date(startedAt.getTime() + seq * 1000);

  await db.alert.create({
    data: {
      fingerprintId: fingerprint.id,
      severity: 'P2',
      message: 'ACC-SW-01 端口 Down',
      firstSeen: cycleStart,
      lastSeen: cycleStart,
      cycleStart,
      externalKey: `${ALERT_PREFIX}${seq}`,
      incidentId: incident.id,
    },
  });

  return incident;
}

async function addHypotheses(incidentId: string, causes: readonly string[]) {
  for (const [index, cause] of causes.entries()) {
    await db.hypothesis.create({
      data: {
        incidentId,
        rank: index + 1,
        cause,
        category: 'HARDWARE',
        confidence: 0.8 - index * 0.2,
        evidence: [{ type: 'ALERT', ref: 'x', desc: 'y' }],
        verifySteps: [],
        actions: [{ action: `处置：${cause}`, risk: 'LOW', requiresApproval: false }],
        source: 'RULE_FALLBACK',
      },
    });
  }
}

describe('AC-08 状态流转', () => {
  it('OPEN → ANALYZING → RESOLVED：写 MTTR、结案记录、状态日志', async () => {
    const incident = await createIncident();

    const analyzing = await transitionIncident({
      idOrCode: incident.code,
      to: 'ANALYZING',
      now: min(1),
    });
    expect(analyzing?.changed).toBe(true);
    expect(analyzing?.statusLog).toHaveLength(1);
    expect(analyzing?.mttrSeconds).toBeNull();

    const resolved = await transitionIncident({
      idOrCode: incident.code,
      to: 'RESOLVED',
      note: '更换板卡后恢复',
      now: min(42),
    });
    expect(resolved?.mttrSeconds).toBe(42 * 60);
    expect(resolved?.changed).toBe(true);

    const detail = await getIncidentDetail(incident.id);
    expect(detail?.status).toBe('RESOLVED');
    expect(detail?.resolvedAt).not.toBeNull();
    expect(detail?.closure).toMatchObject({ note: '更换板卡后恢复' });
    expect(detail?.statusLog.map((entry) => entry.to)).toEqual(['ANALYZING', 'RESOLVED']);
  });

  it('RESOLVED → OPEN 返回 409 INVALID_TRANSITION（AC-08 原文场景）', async () => {
    const incident = await createIncident();
    await transitionIncident({ idOrCode: incident.code, to: 'RESOLVED', now: min(10) });

    await expect(
      transitionIncident({ idOrCode: incident.code, to: 'OPEN', now: min(11) }),
    ).rejects.toMatchObject({ code: 'INVALID_TRANSITION', status: 409 });

    const detail = await getIncidentDetail(incident.id);
    expect(detail?.status).toBe('RESOLVED');
    // 非法流转不能写脏日志
    expect(detail?.statusLog).toHaveLength(1);
  });

  it('重复设置同一状态是幂等的：不追加日志、不重复建报告', async () => {
    const incident = await createIncident();
    await transitionIncident({ idOrCode: incident.code, to: 'RESOLVED', now: min(5) });
    const again = await transitionIncident({
      idOrCode: incident.code,
      to: 'RESOLVED',
      now: min(6),
    });

    expect(again?.changed).toBe(false);
    expect(again?.statusLog).toHaveLength(1);
    expect(await db.report.count({ where: { incidentId: incident.id } })).toBe(1);
  });

  it('事件不存在返回 null（路由层转 404）', async () => {
    expect(await transitionIncident({ idOrCode: 'NOT-EXIST', to: 'RESOLVED' })).toBeNull();
  });

  it('RESOLVED → CLOSED 归档不改 MTTR', async () => {
    const incident = await createIncident();
    await transitionIncident({ idOrCode: incident.code, to: 'RESOLVED', now: min(30) });
    const closed = await transitionIncident({
      idOrCode: incident.code,
      to: 'CLOSED',
      now: min(90),
    });

    expect(closed?.mttrSeconds).toBe(30 * 60);
    const detail = await getIncidentDetail(incident.id);
    expect(detail?.status).toBe('CLOSED');
    expect(detail?.mttrSeconds).toBe(30 * 60);
  });
});

describe('AC-09 结案副作用：案例 + 报告', () => {
  it('结案自动沉淀案例并生成四段报告', async () => {
    const incident = await createIncident();
    await addHypotheses(incident.id, ['CORE-SW-01 板卡硬件故障']);

    const result = await transitionIncident({
      idOrCode: incident.code,
      to: 'RESOLVED',
      note: '更换板卡后恢复',
      now: min(42),
    });
    expect(result?.caseId).not.toBeNull();
    expect(result?.reportId).not.toBeNull();

    const caseRow = await db.caseRecord.findUnique({ where: { incidentId: incident.id } });
    expect(caseRow).not.toBeNull();
    expect(caseRow?.title).toBe('T08 测试事件');
    expect(caseRow?.rootCause).toContain('板卡硬件故障');
    expect(caseRow?.tags).toContain('P2');
    expect(caseRow?.tags).toContain('接入层');

    const report = await db.report.findFirst({
      where: { incidentId: incident.id },
      orderBy: { createdAt: 'desc' },
    });
    expect(report?.markdown).toContain('## 1. MTTR');
    expect(report?.markdown).toContain('42 分钟');
    expect(report?.markdown).toContain('## 2. 影响面');
    expect(report?.markdown).toContain('## 3. 根因');
    expect(report?.markdown).toContain('## 4. 改进项');
    // 未人工采纳时不能冒充人工结论
    expect(report?.markdown).toContain('系统首选（未人工确认）');
  });

  it('未研判直接结案：报告与案例都明确写"证据不足"，不编造根因', async () => {
    const incident = await createIncident();
    await transitionIncident({ idOrCode: incident.code, to: 'RESOLVED', now: min(20) });

    const report = await db.report.findFirst({ where: { incidentId: incident.id } });
    expect(report?.markdown).toContain('未研判或证据不足');

    const caseRow = await db.caseRecord.findUnique({ where: { incidentId: incident.id } });
    expect(caseRow?.rootCause).toContain('未给出根因假设');
  });

  it('采纳的根因写进结案记录与报告', async () => {
    const incident = await createIncident();
    await addHypotheses(incident.id, ['板卡硬件故障', '上游链路抖动']);

    const hypotheses = await db.hypothesis.findMany({
      where: { incidentId: incident.id },
      orderBy: { rank: 'asc' },
      select: { id: true },
    });
    await setHypothesisVerdict({
      incidentIdOrCode: incident.id,
      hypothesisId: hypotheses[1]!.id,
      verdict: 'ACCEPTED',
      note: '现场确认上游链路正常',
    });

    await transitionIncident({ idOrCode: incident.code, to: 'RESOLVED', now: min(30) });

    const detail = await getIncidentDetail(incident.id);
    expect(detail?.closure?.acceptedCause).toBe('上游链路抖动');
    expect(detail?.hypotheses.find((h) => h.verdict === 'ACCEPTED')?.cause).toBe('上游链路抖动');

    const report = await db.report.findFirst({ where: { incidentId: incident.id } });
    expect(report?.markdown).toContain('结论（人工采纳）：**上游链路抖动**');
    expect(report?.markdown).toContain('其它候选（未采纳）');
  });
});

describe('假设裁决（采纳单选）', () => {
  it('采纳第二条时，第一条的 ACCEPTED 被自动降级', async () => {
    const incident = await createIncident();
    await addHypotheses(incident.id, ['原因 A', '原因 B']);
    const hypotheses = await db.hypothesis.findMany({
      where: { incidentId: incident.id },
      orderBy: { rank: 'asc' },
      select: { id: true },
    });

    await setHypothesisVerdict({
      incidentIdOrCode: incident.id,
      hypothesisId: hypotheses[0]!.id,
      verdict: 'ACCEPTED',
    });
    await setHypothesisVerdict({
      incidentIdOrCode: incident.id,
      hypothesisId: hypotheses[1]!.id,
      verdict: 'ACCEPTED',
    });

    const rows = await db.hypothesis.findMany({
      where: { incidentId: incident.id },
      orderBy: { rank: 'asc' },
      select: { rank: true, verdict: true, verdictNote: true },
    });
    expect(rows.map((r) => r.verdict)).toEqual([null, 'ACCEPTED']);
  });

  it('否决后撤销裁决会清空 verdictAt / verdictNote', async () => {
    const incident = await createIncident();
    await addHypotheses(incident.id, ['原因 A']);
    const hypothesis = await db.hypothesis.findFirstOrThrow({
      where: { incidentId: incident.id },
      select: { id: true },
    });

    await setHypothesisVerdict({
      incidentIdOrCode: incident.id,
      hypothesisId: hypothesis.id,
      verdict: 'REJECTED',
      note: '现场排除',
    });
    let row = await db.hypothesis.findUniqueOrThrow({ where: { id: hypothesis.id } });
    expect(row.verdict).toBe('REJECTED');
    expect(row.verdictNote).toBe('现场排除');

    await setHypothesisVerdict({
      incidentIdOrCode: incident.id,
      hypothesisId: hypothesis.id,
      verdict: null,
    });
    row = await db.hypothesis.findUniqueOrThrow({ where: { id: hypothesis.id } });
    expect(row.verdict).toBeNull();
    expect(row.verdictAt).toBeNull();
    expect(row.verdictNote).toBeNull();
  });

  it('假设不属于该事件时不改任何数据', async () => {
    const incidentA = await createIncident();
    const incidentB = await createIncident();
    await addHypotheses(incidentB.id, ['属于 B 的假设']);
    const hypothesisB = await db.hypothesis.findFirstOrThrow({
      where: { incidentId: incidentB.id },
      select: { id: true },
    });

    const result = await setHypothesisVerdict({
      incidentIdOrCode: incidentA.id,
      hypothesisId: hypothesisB.id,
      verdict: 'ACCEPTED',
    });
    expect(result).toBeNull();
    const row = await db.hypothesis.findUniqueOrThrow({ where: { id: hypothesisB.id } });
    expect(row.verdict).toBeNull();
  });
});
