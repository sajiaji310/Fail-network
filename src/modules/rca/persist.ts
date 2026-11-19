import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import type { AnalysisMeta, HypothesisDraft } from './schema';

/**
 * 研判结果落库（T07）。
 *
 * 一次研判 = 整体替换该事件的假设集合，不是增量追加：重跑后旧结论必须消失，
 * 否则"上次说 A、这次说 B"会同时挂在页面上，值班的人会照着过期结论处置。
 * 用事务保证"删旧 + 写新 + 更新事件摘要"三步要么全成要么全不成。
 */

export type PersistInput = {
  incidentId: string;
  hypotheses: readonly HypothesisDraft[];
  summary: string | null;
  impactScope: string | null;
  source: 'LLM' | 'RULE_FALLBACK';
  model: string | null;
  tokensUsed: number | null;
  meta: AnalysisMeta;
};

const asJson = (value: unknown): Prisma.InputJsonValue => value as Prisma.InputJsonValue;

export async function persistAnalysis(input: PersistInput): Promise<void> {
  await db.$transaction(async (tx) => {
    await tx.hypothesis.deleteMany({ where: { incidentId: input.incidentId } });

    for (const [index, hypothesis] of input.hypotheses.entries()) {
      await tx.hypothesis.create({
        data: {
          incidentId: input.incidentId,
          rank: index + 1,
          cause: hypothesis.cause,
          category: hypothesis.category,
          confidence: hypothesis.confidence,
          evidence: asJson(hypothesis.evidence),
          verifySteps: asJson(hypothesis.verifySteps),
          actions: asJson(hypothesis.actions),
          source: input.source,
          model: input.model,
          tokensUsed: input.tokensUsed,
        },
      });
    }

    await tx.incident.update({
      where: { id: input.incidentId },
      data: {
        // 全部被校验器丢弃时清空摘要：宁可页面显示"证据不足"，也不留上一轮的结论
        summary: input.summary,
        impactScope: input.impactScope,
        analysisMeta: asJson(input.meta),
      },
    });
  });
}
