import type { IncidentStatus, Severity } from '@prisma/client';

/**
 * 值班语义：响应时限与事件阶段（评审第 3 阶段）。
 *
 * 这两个概念刻意不落成新的状态枚举：
 * - **响应时限**是「开始 → 有人接手」的时长约定，按严重级定，与故障阶段无关。
 * - **阶段**是从真实字段（状态 / 责任人 / 有无结论 / 有无采纳）派生的展示概念，
 *   不是第六种 IncidentStatus —— 状态机已经够用，再加一层持久化状态只会让
 *   "到底以谁为准"变成永久的争论。
 */

/** 响应目标（分钟）：从 startedAt 到 claimedAt。P0 十分钟内必须有人认领。 */
export const SLA_TARGET_MINUTES: Record<Severity, number> = {
  P0: 10,
  P1: 20,
  P2: 60,
  P3: 240,
};

/** 剩余时间不足目标的 20% 即视为「即将超时」，提前提醒比事后追责有用 */
export const DUE_SOON_RATIO = 0.2;

export type ResponseState = 'UNASSIGNED' | 'WITHIN' | 'DUE_SOON' | 'BREACHED' | 'SETTLED';

export const RESPONSE_STATE_LABEL: Record<ResponseState, string> = {
  UNASSIGNED: '待接手',
  WITHIN: '在时限内',
  DUE_SOON: '即将超时',
  BREACHED: '已超时',
  SETTLED: '已结束',
};

export type ResponseInfo = {
  state: ResponseState;
  /** 本次判定所用的响应目标（分钟）；事件自己有快照时用快照 */
  slaMinutes: number;
  /** 距时限剩余秒数，负数表示已超时多少秒 */
  remainingSeconds: number;
  /** 接手耗时（秒）：未接手为 null，用于 MTTA 统计 */
  claimSeconds: number | null;
  dueAt: string;
};

export type ResponseInput = {
  severity: Severity;
  status: IncidentStatus;
  startedAt: Date;
  claimedAt: Date | null;
  slaMinutes: number | null;
};

/** 事件自己的快照优先：策略收紧后不该追溯把历史事件判成超时 */
export function slaMinutesOf(input: Pick<ResponseInput, 'severity' | 'slaMinutes'>): number {
  return input.slaMinutes ?? SLA_TARGET_MINUTES[input.severity];
}

const SETTLED_STATUSES: readonly IncidentStatus[] = ['RESOLVED', 'CLOSED'];

export function assessResponse(input: ResponseInput, now: Date = new Date()): ResponseInfo {
  const slaMinutes = slaMinutesOf(input);
  const dueAtMs = input.startedAt.getTime() + slaMinutes * 60_000;
  const claimSeconds = input.claimedAt
    ? Math.max(0, Math.round((input.claimedAt.getTime() - input.startedAt.getTime()) / 1000))
    : null;

  // 已结束的事件不再算「超时」：它们该被 MTTA 统计衡量，而不是挂在值班面板上
  if (SETTLED_STATUSES.includes(input.status)) {
    return {
      state: 'SETTLED',
      slaMinutes,
      remainingSeconds: 0,
      claimSeconds,
      dueAt: new Date(dueAtMs).toISOString(),
    };
  }

  const remainingSeconds = Math.round((dueAtMs - now.getTime()) / 1000);

  if (input.claimedAt) {
    // 已接手：是否在时限内接手才是这条事件的响应成绩，接手之后的耗时属于 MTTR 的范畴
    const breached = claimSeconds !== null && claimSeconds > slaMinutes * 60;
    return {
      state: breached ? 'BREACHED' : 'WITHIN',
      slaMinutes,
      remainingSeconds,
      claimSeconds,
      dueAt: new Date(dueAtMs).toISOString(),
    };
  }

  const soon = slaMinutes * 60 * DUE_SOON_RATIO;
  const state: ResponseState =
    remainingSeconds <= 0 ? 'BREACHED' : remainingSeconds <= soon ? 'DUE_SOON' : 'UNASSIGNED';

  return {
    state,
    slaMinutes,
    remainingSeconds,
    claimSeconds: null,
    dueAt: new Date(dueAtMs).toISOString(),
  };
}

/**
 * 事件阶段（评审 5.2：顶部明确展示当前阶段）。
 *
 * 顺序：待接手 → 分析中 → 待确认 → 已定位 → 缓解中 → 已恢复。
 * 评审原文把「待确认」写在「缓解中」之后，但按照真实排障顺序，
 * 人是在拿到候选结论后先确认根因、再动手缓解 —— 所以这里把它放在已定位之前，
 * 与状态机 "LOCATED 之后才有 MITIGATED" 保持一致。
 */
export type IncidentPhase =
  | 'UNASSIGNED'
  | 'INVESTIGATING'
  | 'AWAITING_CONFIRM'
  | 'LOCATED'
  | 'MITIGATED'
  | 'RESOLVED'
  | 'ARCHIVED';

export const PHASE_ORDER: readonly IncidentPhase[] = [
  'UNASSIGNED',
  'INVESTIGATING',
  'AWAITING_CONFIRM',
  'LOCATED',
  'MITIGATED',
  'RESOLVED',
  'ARCHIVED',
];

export const PHASE_LABEL: Record<IncidentPhase, string> = {
  UNASSIGNED: '待接手',
  INVESTIGATING: '分析中',
  AWAITING_CONFIRM: '待确认',
  LOCATED: '已定位',
  MITIGATED: '缓解中',
  RESOLVED: '已恢复',
  ARCHIVED: '已归档',
};

export type PhaseInput = {
  status: IncidentStatus;
  assignee: string | null;
  /** 是否有过研判结论（有假设即算） */
  hasAnalysis: boolean;
  /** 是否有人工采纳的假设 */
  hasAccepted: boolean;
};

export function derivePhase(input: PhaseInput): IncidentPhase {
  if (input.status === 'CLOSED') return 'ARCHIVED';
  if (input.status === 'RESOLVED') return 'RESOLVED';
  if (input.status === 'MITIGATED') return 'MITIGATED';
  if (input.status === 'LOCATED') return 'LOCATED';
  if (!input.assignee) return 'UNASSIGNED';
  // 有结论但没人拍板：这是最该被催的一步 —— AI 已经给出候选，卡在人工确认上
  if (input.hasAnalysis && !input.hasAccepted) return 'AWAITING_CONFIRM';
  return 'INVESTIGATING';
}

/** 阶段进度条用：返回当前阶段下标与已完成比例 */
export function phaseProgress(phase: IncidentPhase): { index: number; total: number } {
  return { index: PHASE_ORDER.indexOf(phase), total: PHASE_ORDER.length };
}
