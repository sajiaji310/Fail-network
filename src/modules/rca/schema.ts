import { z } from 'zod';

/**
 * 研判输出契约（文档 10.2）：同一份 schema 既校验模型输出，也作为前端类型来源。
 *
 * 注意 `hypotheses.min(1)` 是**模型输出**的约束，不是最终展示的约束：
 * 证据校验后可能剩 0 条（AC-20），那一层用 `VerifiedResult` 表达，别混用。
 */

export const EvidenceTypeSchema = z.enum(['ALERT', 'CHANGE', 'TOPOLOGY', 'CASE']);
export const HypothesisCategorySchema = z.enum([
  'HARDWARE',
  'CONFIG',
  'LINK',
  'CAPACITY',
  'UPSTREAM',
  'OTHER',
]);
export const RiskSchema = z.enum(['LOW', 'MEDIUM', 'HIGH']);

export const EvidenceSchema = z.object({
  type: EvidenceTypeSchema,
  /** 必须是库内真实 id：alertId / changeId / linkId / caseId */
  ref: z.string().min(1),
  desc: z.string().max(160),
});

export const ActionSchema = z.object({
  action: z.string().min(2).max(120),
  risk: RiskSchema,
  requiresApproval: z.boolean(),
});

export const HypothesisSchema = z.object({
  cause: z.string().min(4).max(120),
  category: HypothesisCategorySchema,
  confidence: z.number().min(0).max(1),
  evidence: z.array(EvidenceSchema).min(1).max(8),
  verifySteps: z.array(z.string().min(2).max(160)).min(1).max(5),
  actions: z.array(ActionSchema).max(5),
});

export const AnalysisResultSchema = z.object({
  summary: z.string().min(2).max(200),
  impactScope: z.string().min(2).max(200),
  severity: z.enum(['P0', 'P1', 'P2', 'P3']),
  hypotheses: z.array(HypothesisSchema).min(1).max(3),
  missingInfo: z.array(z.string().max(120)).max(5),
});

export type Evidence = z.infer<typeof EvidenceSchema>;
export type HypothesisDraft = z.infer<typeof HypothesisSchema>;
export type AnalysisResult = z.infer<typeof AnalysisResultSchema>;
export type HypothesisCategory = z.infer<typeof HypothesisCategorySchema>;
export type Risk = z.infer<typeof RiskSchema>;

/** 校验器丢弃原因（文档 10.3 的三个枚举，前端与 evals 都按它统计） */
export type DroppedReason = 'NO_EVIDENCE' | 'EVIDENCE_NOT_FOUND' | 'EVIDENCE_IRRELEVANT';

export type Drop = { cause: string; reason: DroppedReason; detail?: string };

export type VerifyResult = {
  kept: HypothesisDraft[];
  dropped: Drop[];
  stats: { rawEvidence: number; validEvidence: number; relevanceRate: number };
};

/**
 * 落库的研判审计元数据（Incident.analysisMeta）。
 * 文档 10.3 要求"校验结果要落库，用于 eval 与事后审计"，但 8 节模型漏了这个字段。
 * 读的时候一律过 schema：JSON 列是 unknown，历史数据可能缺键，不能直接当类型用。
 */
export const AnalysisMetaSchema = z.object({
  analyzedAt: z.string(),
  source: z.enum(['LLM', 'RULE_FALLBACK']),
  model: z.string().nullable(),
  promptVersion: z.string(),
  missingInfo: z.array(z.string()).default([]),
  verify: z.object({
    dropped: z.array(
      z.object({
        cause: z.string(),
        reason: z.enum(['NO_EVIDENCE', 'EVIDENCE_NOT_FOUND', 'EVIDENCE_IRRELEVANT']),
        detail: z.string().optional(),
      }),
    ),
    stats: z.object({
      rawEvidence: z.number(),
      validEvidence: z.number(),
      relevanceRate: z.number(),
    }),
  }),
  trim: z.array(z.string()).default([]),
  degradedReason: z.string().nullable().default(null),
});

export type AnalysisMeta = z.infer<typeof AnalysisMetaSchema>;

export function parseAnalysisMeta(value: unknown): AnalysisMeta | null {
  const parsed = AnalysisMetaSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
