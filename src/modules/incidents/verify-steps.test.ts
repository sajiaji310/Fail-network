import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import type { AppError } from '@/lib/errors';
import { countPendingVerify, setVerifyStep } from './verify-steps';

/**
 * 验证步骤勾选（评审第 3 阶段）。
 *
 * 行为约定：
 * - 勾选是 upsert（幂等），取消勾选是删行；
 * - 下标越界 400，假设不属于该事件 404；
 * - by 由调用方（路由层从身份解析）传入，这里只负责存。
 */

const BASE = new Date('2026-11-13T02:00:00Z');
let seq = 0;

const STEPS = ['确认板卡状态', '核对上联端口', '查近 24h 变更'];

async function makeFixture(): Promise<{ incidentId: string; hypothesisId: string }> {
  seq++;
  const incident = await db.incident.create({
    data: {
      code: `INC-20261113-9${String(seq).padStart(2, '0')}`,
      title: '验证勾选测试事件',
      status: 'OPEN',
      severity: 'P1',
      startedAt: BASE,
      lastSeen: BASE,
    },
    select: { id: true },
  });
  const hypothesis = await db.hypothesis.create({
    data: {
      incidentId: incident.id,
      rank: 1,
      cause: '测试根因',
      category: 'HARDWARE',
      confidence: 0.6,
      evidence: [],
      verifySteps: STEPS,
      actions: [],
      source: 'RULE_FALLBACK',
    },
    select: { id: true },
  });
  return { incidentId: incident.id, hypothesisId: hypothesis.id };
}

async function cleanup() {
  await db.incident.deleteMany({ where: { code: { startsWith: 'INC-20261113-9' } } });
}

beforeEach(cleanup);
afterAll(cleanup);

describe('setVerifyStep', () => {
  it('勾选后进度 +1，并记录操作者与步骤快照', async () => {
    const { incidentId, hypothesisId } = await makeFixture();

    const result = await setVerifyStep({
      incidentIdOrCode: incidentId,
      hypothesisId,
      stepIndex: 1,
      done: true,
      note: '上联端口正常',
      by: '陈昊',
      now: BASE,
    });

    expect(result!.total).toBe(3);
    expect(result!.done).toBe(1);
    expect(result!.steps[1]!.done).toBe(true);
    expect(result!.steps[1]!.by).toBe('陈昊');
    expect(result!.steps[1]!.note).toBe('上联端口正常');

    const row = await db.hypothesisVerify.findFirstOrThrow({
      where: { hypothesisId },
      select: { stepText: true, stepIndex: true },
    });
    expect(row.stepText).toBe(STEPS[1]);
    expect(row.stepIndex).toBe(1);
  });

  it('重复勾选是幂等的，不会出现两行', async () => {
    const { incidentId, hypothesisId } = await makeFixture();
    await setVerifyStep({
      incidentIdOrCode: incidentId,
      hypothesisId,
      stepIndex: 0,
      done: true,
      by: '陈昊',
    });
    const again = await setVerifyStep({
      incidentIdOrCode: incidentId,
      hypothesisId,
      stepIndex: 0,
      done: true,
      note: '再确认一次',
      by: '李锐',
    });

    expect(again!.done).toBe(1);
    expect(await db.hypothesisVerify.count({ where: { hypothesisId } })).toBe(1);
    expect(again!.steps[0]!.by).toBe('李锐');
    expect(again!.steps[0]!.note).toBe('再确认一次');
  });

  it('取消勾选删行，进度回落', async () => {
    const { incidentId, hypothesisId } = await makeFixture();
    await setVerifyStep({
      incidentIdOrCode: incidentId,
      hypothesisId,
      stepIndex: 2,
      done: true,
      by: '陈昊',
    });
    const result = await setVerifyStep({
      incidentIdOrCode: incidentId,
      hypothesisId,
      stepIndex: 2,
      done: false,
    });

    expect(result!.done).toBe(0);
    expect(await db.hypothesisVerify.count({ where: { hypothesisId } })).toBe(0);
  });

  it('下标越界 → 400 VALIDATION_FAILED', async () => {
    const { incidentId, hypothesisId } = await makeFixture();
    try {
      await setVerifyStep({
        incidentIdOrCode: incidentId,
        hypothesisId,
        stepIndex: 3,
        done: true,
      });
      throw new Error('应当抛错');
    } catch (error) {
      expect((error as AppError).code).toBe('VALIDATION_FAILED');
      expect((error as AppError).status).toBe(400);
    }
  });

  it('假设不属于该事件 → 404', async () => {
    const a = await makeFixture();
    const b = await makeFixture();
    try {
      await setVerifyStep({
        incidentIdOrCode: a.incidentId,
        hypothesisId: b.hypothesisId,
        stepIndex: 0,
        done: true,
      });
      throw new Error('应当抛错');
    } catch (error) {
      expect((error as AppError).code).toBe('NOT_FOUND');
    }
  });
});

describe('countPendingVerify', () => {
  it('返回尚未勾选的步骤数，结案提示用', async () => {
    const { incidentId, hypothesisId } = await makeFixture();
    expect(await countPendingVerify(hypothesisId)).toBe(3);

    await setVerifyStep({
      incidentIdOrCode: incidentId,
      hypothesisId,
      stepIndex: 0,
      done: true,
      by: '陈昊',
    });
    expect(await countPendingVerify(hypothesisId)).toBe(2);
  });
});
