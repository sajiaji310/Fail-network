import { z } from 'zod';

/**
 * 研判输出契约（文档 10.2）：同一份 schema 既校验模型输出，也作为前端类型来源。
 *
 * 注意 `hypotheses.min(1)` 是**模型输出**的约束，不是最终展示的约束：
 * 证据校验后可能剩 0 条（AC-20），那一层用 `VerifiedResult` 表达，别混用。
 */

export const EvidenceTypeSchema = z.enum(['ALERT', 'CHANGE', 'TOPOLOGY', 'CASE', 'METRIC']);
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
  desc: z.string().max(80),
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
  /**
   * 上限一律只收紧、不改类型不改必填性（Spec §3.6）：
   * desc 160→80、verifySteps 5→3、actions 5→2。
   *
   * evidence 保留 max 8，比 Spec 表里的 3 宽 —— 这是有意的安全阀：prompt 要求模型最多写 3 条，
   * 但把 schema 也焊死在 3，会让"多引了一条证据"的假设被结构性拒绝（重试一次仍超限就整条降级），
   * 代价远大于省下的几十个 token。**prompt 管体量，schema 只管底线**。
   */
  evidence: z.array(EvidenceSchema).min(1).max(8),
  verifySteps: z.array(z.string().min(2).max(160)).min(1).max(3),
  actions: z.array(ActionSchema).max(2),
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
  /** 本次研判的 token 用量：评测要算成本，缓存命中时也要能读回来 */
  tokensUsed: z.number().nullable().optional(),
  /**
   * 拒答门禁的记录（Spec §3.3 / PRD AC-2）：
   *   R1 命中记 `{ rule:'R1', hit:true }` —— 规则编号必须落库，事后要能回答"是哪条规则拒的"；
   *   GATE-02 清空记 `cleared` 条数与逐条原因。
   * 落库理由：拒答是**需要复盘的事件**，要能区分"模型没给结论"和"门禁清空了它的结论"。
   */
  gate: z
    .object({
      cleared: z.number(),
      reasons: z.array(z.string()),
      rule: z.enum(['R1']).optional(),
      hit: z.boolean().optional(),
    })
    .optional(),
  /** 本次研判的提示词形态（RCA_HINT 开/关）：A/B 对比与回滚复盘都要能对上号 */
  promptHint: z.enum(['on', 'off']).optional(),
  /** 本次是门禁拒答（未调用模型）而非模型失败降级：延迟统计必须能把这两种分开 */
  abstained: z.boolean().optional(),
  /**
   * 逐条假设的来源（Spec §3.4）。与 hypotheses 同序同长：
   * 空结论补位之后，同一份结论里可能一半来自模型、一半来自规则引擎，
   * 用一个全局 source 概括会让"提升到底靠谁"这件事永远说不清。
   */
  hypothesesOrigin: z.array(z.enum(['LLM', 'RULE_FALLBACK'])).optional(),
  /** 研判时的拓扑完整度（评审 P0-4）：缺拓扑时置信度已按上限下调，事后可复核 */
  topology: z
    .object({
      level: z.enum(['FULL', 'PARTIAL', 'MISSING']),
      deviceCount: z.number(),
      linkedDevices: z.number(),
      isolatedDevices: z.number(),
      components: z.number(),
      maxHops: z.number().optional(),
    })
    .optional(),
});

export type AnalysisMeta = z.infer<typeof AnalysisMetaSchema>;

export function parseAnalysisMeta(value: unknown): AnalysisMeta | null {
  const parsed = AnalysisMetaSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
