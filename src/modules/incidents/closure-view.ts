import type { IncidentStatus } from '@prisma/client';

/**
 * 结案审计的读模型（容错解析）。
 *
 * statusLog / closure 是 JSON 列，写入方只有 lifecycle.ts，但读的一方有页面、API、
 * 报告三处 —— 解析集中在这里，遇到坏数据就退化成"没有记录"，不让一列脏数据把页面打挂。
 */

export type StatusLogEntry = {
  from: IncidentStatus;
  to: IncidentStatus;
  at: string;
  note: string | null;
};

export type ClosureRecord = {
  at: string;
  note: string | null;
  acceptedHypothesisId: string | null;
  acceptedCause: string | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function parseStatusLog(value: unknown): StatusLogEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = asRecord(item);
    if (!record) return [];
    const from = str(record.from);
    const to = str(record.to);
    const at = str(record.at);
    if (!from || !to || !at) return [];
    return [{ from: from as IncidentStatus, to: to as IncidentStatus, at, note: str(record.note) }];
  });
}

export function parseClosure(value: unknown): ClosureRecord | null {
  const record = asRecord(value);
  if (!record) return null;
  const at = str(record.at);
  if (!at) return null;
  return {
    at,
    note: str(record.note),
    acceptedHypothesisId: str(record.acceptedHypothesisId),
    acceptedCause: str(record.acceptedCause),
  };
}
