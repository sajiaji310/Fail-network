import { FOLLOWUP_LOOKBACK_MS } from './constants';
import { runCorrelation, type CorrelationSummary } from './service';

/** 一次回放最长 7 天。更长的历史拆成多次调用，避免一次走完整库。 */
export const MAX_REPLAY_SPAN_MS = 7 * 24 * 60 * 60 * 1000;

export type ReplayCursorInput = {
  from: Date;
  to: Date;
  /** 每步推进多久。不能大于 2 小时回看窗，否则两步之间的告警不会被任何一次聚合看到。 */
  stepMs?: number;
};

export type ReplaySummary = {
  from: string;
  to: string;
  steps: number;
  created: CorrelationSummary['created'];
  updated: CorrelationSummary['updated'];
  reopened: CorrelationSummary['reopened'];
  converged: CorrelationSummary['converged'];
  merged: CorrelationSummary['merged'];
  durationMs: number;
};

/**
 * 回放用的聚合时刻。
 *
 * `runCorrelation(now)` 只取 lastSeen 落在 [now-2h, now] 里的活跃告警。
 * 从 `from` 起步、每次最多前进一个回看窗、最后停在 `to`，
 * 这段时间里的告警都会至少落进一次窗口，也不会一次把一整天丢进内存聚类。
 */
export function replayCursors({ from, to, stepMs }: ReplayCursorInput): Date[] {
  const start = from.getTime();
  const end = to.getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    throw new Error('回放时间不合法');
  }
  if (end < start) throw new Error('回放的结束时间不能早于开始时间');
  if (end - start > MAX_REPLAY_SPAN_MS) {
    throw new Error('一次回放最长 7 天');
  }
  const step = stepMs ?? FOLLOWUP_LOOKBACK_MS;
  if (!Number.isFinite(step) || step <= 0) throw new Error('回放步长必须大于 0');
  if (step > FOLLOWUP_LOOKBACK_MS) {
    throw new Error('回放步长不能大于 2 小时，否则窗口之间会漏告警');
  }

  const cursors: Date[] = [];
  let cursor = start;
  while (cursor < end) {
    cursors.push(new Date(cursor));
    const next = Math.min(cursor + step, end);
    if (next === cursor) break;
    cursor = next;
  }
  cursors.push(new Date(end));
  return cursors;
}

/**
 * 按告警自己的时间重放聚合。
 *
 * 不改 firstSeen / lastSeen。每一跳把该时刻当作 `now` 调用现有的 `runCorrelation`，
 * 延续、二次收敛和合并规则保持原样。已经归属的告警再次进入窗口时走幂等路径。
 */
export async function replayCorrelation(
  input: ReplayCursorInput & { tenantId?: string },
): Promise<ReplaySummary> {
  const started = Date.now();
  const cursors = replayCursors(input);
  const tenantId = input.tenantId ?? 'default';
  const summary: ReplaySummary = {
    from: input.from.toISOString(),
    to: input.to.toISOString(),
    steps: cursors.length,
    created: [],
    updated: [],
    reopened: [],
    converged: [],
    merged: [],
    durationMs: 0,
  };

  for (const cursor of cursors) {
    const step = await runCorrelation(cursor, tenantId);
    summary.created.push(...step.created);
    summary.updated.push(...step.updated);
    summary.reopened.push(...step.reopened);
    summary.converged.push(...step.converged);
    summary.merged.push(...step.merged);
  }

  summary.durationMs = Date.now() - started;
  return summary;
}
