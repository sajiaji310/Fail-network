import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { CaseVerification } from '@prisma/client';
import { db } from '@/lib/db';
import { signatureOf } from '@/modules/alerts/fingerprint';
import { buildIncidentContext } from '@/modules/rca/context';
import { getIncidentDetail } from '@/modules/incidents/detail';
import { setHypothesisVerdict, transitionIncident } from '@/modules/incidents/lifecycle';
import { buildCaseDraft, setCaseVerification, upsertCase } from './service';

/**
 * 案例可信度（评审 P0-3「案例污染率 = 0」）。
 *
 * 要证明的是两件事，缺一不可：
 * 1. 标记本身正确：结案时有人工采纳 → VERIFIED，没有 → UNVERIFIED；
 * 2. 标记真的影响召回：UNVERIFIED / REJECTED 的案例不出现在研判上下文里。
 *
 * 只做第 1 条等于加了个字段没人用 —— 那是最容易被误认为"已修复"的假修复。
 */

const CODE_PREFIX = 'T-VER-';
const ALERT_PREFIX = 'T-VER-A-';
const BASE = new Date('2026-02-10T09:00:00Z');
const TAG = '时延';

let seq = 0;

async function cleanup() {
  await db.alert.deleteMany({ where: { externalKey: { startsWith: ALERT_PREFIX } } });
  await db.incident.deleteMany({ where: { code: { startsWith: CODE_PREFIX } } });
}

beforeEach(cleanup);
afterAll(cleanup);

async function createIncident(): Promise<{ id: string; code: string }> {
  seq += 1;
  const device = await db.device.findFirstOrThrow({
    where: { name: 'ACC-SW-01' },
    select: { id: true },
  });
  // 用 HIGH_LATENCY：标签「高时延」能命中 QUALITY 族的案例 tag「时延」，
  // 召回测试才有意义（否则案例会因"不相关"被过滤，测不出召回策略）
  const signature = signatureOf(device.id, 'HIGH_LATENCY', 'tver');
  const fingerprint = await db.alertFingerprint.upsert({
    where: { signature },
    create: {
      signature,
      deviceId: device.id,
      type: 'HIGH_LATENCY',
      metric: 'tver',
      severity: 'P2',
    },
    update: {},
  });

  const incident = await db.incident.create({
    data: {
      code: `${CODE_PREFIX}${seq}`,
      title: 'T-VER 时延抖动事件',
      status: 'OPEN',
      severity: 'P2',
      startedAt: BASE,
      lastSeen: BASE,
      clusterKey: `T-VER-KEY-${seq}-${Date.now()}`,
    },
    select: { id: true, code: true },
  });

  const cycleStart = new Date(BASE.getTime() + seq * 1000);
  await db.alert.create({
    data: {
      fingerprintId: fingerprint.id,
      severity: 'P2',
      message: 'ACC-SW-01 时延超过阈值',
      firstSeen: cycleStart,
      lastSeen: cycleStart,
      cycleStart,
      externalKey: `${ALERT_PREFIX}${seq}`,
      incidentId: incident.id,
    },
  });

  return incident;
}

async function addHypothesis(incidentId: string, cause: string): Promise<string> {
  const row = await db.hypothesis.create({
    data: {
      incidentId,
      rank: 1,
      cause,
      category: 'LINK',
      confidence: 0.72,
      evidence: [{ type: 'ALERT', ref: 'x', desc: 'y' }],
      verifySteps: [],
      actions: [{ action: `处置：${cause}`, risk: 'LOW', requiresApproval: false }],
      source: 'RULE_FALLBACK',
    },
    select: { id: true },
  });
  return row.id;
}

async function seedCase(
  incidentId: string,
  verification: CaseVerification,
  tags: string[] = [TAG],
): Promise<string> {
  const row = await db.caseRecord.create({
    data: {
      incidentId,
      title: 'T-VER 历史案例',
      symptom: '接入交换机时延抖动',
      rootCause: '上联光模块光衰',
      resolution: '更换光模块',
      tags,
      verification,
      verifiedAt: verification === 'VERIFIED' ? new Date() : null,
      verifiedBy: verification === 'VERIFIED' ? 'tester' : null,
    },
    select: { id: true },
  });
  return row.id;
}

async function recalledCaseIds(incidentCode: string): Promise<string[]> {
  const bundle = await buildIncidentContext(incidentCode);
  expect(bundle).not.toBeNull();
  return bundle?.cases.map((c) => c.id) ?? [];
}

describe('结案时写入可信度', () => {
  it('没有人工采纳 → UNVERIFIED，并写明「未经人工确认」', async () => {
    const incident = await createIncident();
    await addHypothesis(incident.id, '上联光模块光衰');

    await transitionIncident({ idOrCode: incident.code, to: 'RESOLVED', now: BASE });

    const caseRow = await db.caseRecord.findUnique({ where: { incidentId: incident.id } });
    expect(caseRow?.verification).toBe('UNVERIFIED');
    expect(caseRow?.verifiedAt).toBeNull();
    expect(caseRow?.verifyNote).toContain('未经人工确认');
  });

  it('人工采纳了假设 → VERIFIED', async () => {
    const incident = await createIncident();
    const hypothesisId = await addHypothesis(incident.id, '上联光模块光衰');
    await setHypothesisVerdict({
      incidentIdOrCode: incident.code,
      hypothesisId,
      verdict: 'ACCEPTED',
      note: '现场确认光衰 -18dBm',
      now: BASE,
    });

    await transitionIncident({ idOrCode: incident.code, to: 'RESOLVED', now: BASE });

    const caseRow = await db.caseRecord.findUnique({ where: { incidentId: incident.id } });
    expect(caseRow?.verification).toBe('VERIFIED');
    expect(caseRow?.verifyNote).toContain('人工采纳');
  });
});

describe('只有 VERIFIED 进入研判召回', () => {
  it('同样相关的两条案例，未验证那条不出现在上下文里', async () => {
    const incident = await createIncident();
    const verifiedId = await seedCase(incident.id, 'VERIFIED');

    // 另一条同 tag 的未验证案例：直接挂在同一个事件下不合法（incidentId unique），
    // 所以单独建事件再挂案例
    const other = await createIncident();
    const unverifiedId = await seedCase(other.id, 'UNVERIFIED');

    const ids = await recalledCaseIds(incident.code);
    expect(ids).toContain(verifiedId);
    expect(ids).not.toContain(unverifiedId);
  });

  it('人工确认后立刻进入召回', async () => {
    const incident = await createIncident();
    const other = await createIncident();
    const caseId = await seedCase(other.id, 'UNVERIFIED');

    expect(await recalledCaseIds(incident.code)).not.toContain(caseId);

    const updated = await setCaseVerification({
      id: caseId,
      verification: 'VERIFIED',
      by: 'tester',
      note: '核对过现场记录',
    });
    expect(updated?.verification).toBe('VERIFIED');
    expect(updated?.verifiedAt).not.toBeNull();

    expect(await recalledCaseIds(incident.code)).toContain(caseId);
  });

  it('驳回后立即退出召回（错误经验比没有经验更危险）', async () => {
    const incident = await createIncident();
    const other = await createIncident();
    const caseId = await seedCase(other.id, 'VERIFIED');
    expect(await recalledCaseIds(incident.code)).toContain(caseId);

    await setCaseVerification({ id: caseId, verification: 'REJECTED', by: 'tester' });

    expect(await recalledCaseIds(incident.code)).not.toContain(caseId);
  });
});

describe('重复沉淀不覆盖人工裁决', () => {
  it('人工确认过的案例，重开再结案不会被打回 UNVERIFIED', async () => {
    const incident = await createIncident();
    const hypothesisId = await addHypothesis(incident.id, '上联光模块光衰');
    await setHypothesisVerdict({
      incidentIdOrCode: incident.code,
      hypothesisId,
      verdict: 'ACCEPTED',
      now: BASE,
    });
    await transitionIncident({ idOrCode: incident.code, to: 'RESOLVED', now: BASE });

    const caseRow = await db.caseRecord.findUniqueOrThrow({ where: { incidentId: incident.id } });
    await setCaseVerification({ id: caseRow.id, verification: 'REJECTED', by: 'tester' });

    // 模拟"重开后又结案"时再次沉淀：draft 这次是 UNVERIFIED（假设被重新研判替换掉）
    const detail = await getIncidentDetail(incident.id);
    expect(detail).not.toBeNull();
    await upsertCase(incident.id, buildCaseDraft(detail!, null));

    const after = await db.caseRecord.findUnique({ where: { incidentId: incident.id } });
    expect(after?.id).toBe(caseRow.id);
    expect(after?.verification).toBe('REJECTED');
  });

  it('案例不存在时返回 null（路由层转 404）', async () => {
    expect(
      await setCaseVerification({ id: 'NOT-EXIST', verification: 'VERIFIED', by: 'tester' }),
    ).toBeNull();
  });
});
