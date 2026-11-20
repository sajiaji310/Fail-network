import { db } from '@/lib/db';
import { AppError } from '@/lib/errors';
import { toVerifyView, type VerifyStepView, type VerifyView } from './hypothesis-view';

/**
 * 验证步骤勾选（评审 5.2「将验证步骤变成可勾选清单，保存验证结果和操作者」）。
 *
 * 存"勾上的行"而不是整份 JSON：
 * - 勾选是并发写操作，行级 upsert 天然幂等，两个人同点也不会互相覆盖；
 * - 「已验 M/N 步」是一次 count，不用把整份清单读出来再数；
 * - 每一步带 by / at，事后能回答"这条假设是谁验的、验到哪一步"。
 *
 * 步骤文案在勾选时**快照**进 stepText：假设被重新研判后旧记录级联删除，
 * 但在删除之前，报告里引用的是当时那句原文，而不是新一版的下标对应关系。
 */

export type SetVerifyStepInput = {
  incidentIdOrCode: string;
  hypothesisId: string;
  stepIndex: number;
  done: boolean;
  note?: string | null;
  by?: string | null;
  now?: Date;
};

export type VerifyProgress = VerifyView & {
  hypothesisId: string;
};

export type { VerifyStepView };

export async function setVerifyStep(input: SetVerifyStepInput): Promise<VerifyProgress | null> {
  const now = input.now ?? new Date();
  const incident = await db.incident.findFirst({
    where: { OR: [{ id: input.incidentIdOrCode }, { code: input.incidentIdOrCode }] },
    select: { id: true },
  });
  if (!incident) return null;

  const hypothesis = await db.hypothesis.findFirst({
    where: { id: input.hypothesisId, incidentId: incident.id },
    select: { id: true, verifySteps: true },
  });
  if (!hypothesis) {
    throw new AppError('NOT_FOUND', '假设不存在或不属于该事件');
  }

  const steps = Array.isArray(hypothesis.verifySteps)
    ? hypothesis.verifySteps.flatMap((s) => (typeof s === 'string' ? [s] : []))
    : [];

  const text = steps[input.stepIndex];
  if (text === undefined) {
    throw new AppError(
      'VALIDATION_FAILED',
      `验证步骤下标越界：${input.stepIndex}（该假设共 ${steps.length} 步）`,
      { stepIndex: input.stepIndex, total: steps.length },
    );
  }

  if (input.done) {
    await db.hypothesisVerify.upsert({
      where: {
        hypothesisId_stepIndex: { hypothesisId: hypothesis.id, stepIndex: input.stepIndex },
      },
      create: {
        hypothesisId: hypothesis.id,
        stepIndex: input.stepIndex,
        stepText: text,
        note: input.note?.trim() || null,
        by: input.by?.trim() || null,
        at: now,
      },
      // 重复勾选视为"重新确认一次"：更新备注与时间，而不是静默忽略
      update: {
        stepText: text,
        note: input.note?.trim() || null,
        by: input.by?.trim() || null,
        at: now,
      },
    });
  } else {
    // 取消勾选 = 删行，天然幂等
    await db.hypothesisVerify.deleteMany({
      where: { hypothesisId: hypothesis.id, stepIndex: input.stepIndex },
    });
  }

  const checks = await db.hypothesisVerify.findMany({
    where: { hypothesisId: hypothesis.id },
    orderBy: { stepIndex: 'asc' },
    select: { stepIndex: true, stepText: true, note: true, by: true, at: true },
  });

  return { hypothesisId: hypothesis.id, ...toVerifyView(steps, checks) };
}

/** 结案前检查：返回未完成的验证步骤数（0 表示都验过或本来就没有步骤） */
export async function countPendingVerify(hypothesisId: string): Promise<number> {
  const hypothesis = await db.hypothesis.findUnique({
    where: { id: hypothesisId },
    select: { verifySteps: true, verifyChecks: { select: { stepIndex: true } } },
  });
  if (!hypothesis) return 0;
  const total = Array.isArray(hypothesis.verifySteps) ? hypothesis.verifySteps.length : 0;
  return Math.max(0, total - hypothesis.verifyChecks.length);
}
