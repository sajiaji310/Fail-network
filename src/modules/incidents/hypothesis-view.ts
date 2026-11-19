/**
 * 假设的展示模型：把 Prisma 的 JSON 列（unknown）收窄成前端能直接渲染的形状。
 *
 * 单独成文件的两个原因：① detail.ts 已接近 300 行上限；② JSON 列的容错逻辑
 * 只该有一份 —— 页面、API、导出报告都从这里取，坏数据在这里退化，不扩散。
 */

export type EvidenceView = {
  type: string;
  ref: string;
  desc: string;
};

export type ActionView = {
  action: string;
  risk: string;
  requiresApproval: boolean;
};

export type HypothesisView = {
  id: string;
  rank: number;
  cause: string;
  category: string;
  confidence: number;
  source: string;
  model: string | null;
  evidence: EvidenceView[];
  verifySteps: string[];
  actions: ActionView[];
  evidenceCount: number;
  verifyStepCount: number;
  /** ACCEPTED / REJECTED / null（未裁决）—— T08 人工确认 */
  verdict: string | null;
  verdictAt: string | null;
  verdictNote: string | null;
};

type HypothesisRow = {
  id: string;
  rank: number;
  cause: string;
  category: string;
  confidence: number;
  source: string;
  model: string | null;
  evidence: unknown;
  verifySteps: unknown;
  actions: unknown;
  verdict?: string | null;
  verdictAt?: Date | null;
  verdictNote?: string | null;
};

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

export function toEvidenceView(value: unknown): EvidenceView[] {
  return asArray(value).flatMap((item) => {
    const record = asRecord(item);
    const ref = readString(record.ref);
    if (!ref) return [];
    return [{ type: readString(record.type, 'ALERT'), ref, desc: readString(record.desc) }];
  });
}

export function toActionView(value: unknown): ActionView[] {
  return asArray(value).flatMap((item) => {
    const record = asRecord(item);
    const action = readString(record.action);
    if (!action) return [];
    return [
      {
        action,
        risk: readString(record.risk, 'LOW'),
        requiresApproval: record.requiresApproval === true,
      },
    ];
  });
}

function toStringList(value: unknown): string[] {
  return asArray(value).flatMap((item) => (typeof item === 'string' ? [item] : []));
}

export function toHypothesisView(row: HypothesisRow): HypothesisView {
  const evidence = toEvidenceView(row.evidence);
  const verifySteps = toStringList(row.verifySteps);
  return {
    id: row.id,
    rank: row.rank,
    cause: row.cause,
    category: row.category,
    confidence: row.confidence,
    source: row.source,
    model: row.model,
    evidence,
    verifySteps,
    actions: toActionView(row.actions),
    evidenceCount: evidence.length,
    verifyStepCount: verifySteps.length,
    verdict: row.verdict ?? null,
    verdictAt: row.verdictAt ? row.verdictAt.toISOString() : null,
    verdictNote: row.verdictNote ?? null,
  };
}
