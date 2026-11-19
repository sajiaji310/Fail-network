import type { IncidentStatus } from '@prisma/client';
import { AppError } from '@/lib/errors';
import { INCIDENT_STATUS_LABEL } from './status';

/**
 * 事件状态机（文档 F7「人工确认与结案」/ AC-08）。
 *
 * 两条规则：
 * 1. **只向前，不向后**。RESOLVED → OPEN 必须 409：状态是审计材料，
 *    回退之后 resolvedAt / mttrSeconds 是信不过的，报告也就没有意义。
 * 2. **允许跳级**。小故障常常 OPEN 直接结案；逼着人先点"研判中"再点"已定位"
 *    只是给系统看的仪式，反而让人养成乱点的习惯。
 *
 * 唯一的重开路径是 B6 的自动重开（30 分钟内同簇再现），它是系统行为，
 * 走 correlation/persist.reopenIncident，不经过这里 —— 人工接口不提供回退。
 */

export const INCIDENT_TRANSITIONS: Record<IncidentStatus, readonly IncidentStatus[]> = {
  OPEN: ['ANALYZING', 'LOCATED', 'MITIGATED', 'RESOLVED'],
  ANALYZING: ['LOCATED', 'MITIGATED', 'RESOLVED'],
  LOCATED: ['MITIGATED', 'RESOLVED'],
  MITIGATED: ['RESOLVED'],
  RESOLVED: ['CLOSED'],
  CLOSED: [],
};

/** 所有可作为 PATCH 目标的状态（按流程顺序，用于 UI 排序） */
export const INCIDENT_STATUS_ORDER: readonly IncidentStatus[] = [
  'OPEN',
  'ANALYZING',
  'LOCATED',
  'MITIGATED',
  'RESOLVED',
  'CLOSED',
];

export function nextStatuses(from: IncidentStatus): readonly IncidentStatus[] {
  return INCIDENT_TRANSITIONS[from];
}

export function canTransition(from: IncidentStatus, to: IncidentStatus): boolean {
  return INCIDENT_TRANSITIONS[from].includes(to);
}

export function isTerminal(status: IncidentStatus): boolean {
  return INCIDENT_TRANSITIONS[status].length === 0;
}

/**
 * 非法流转直接抛 409。同状态不算合法流转（幂等由调用方先行短路），
 * 这样"把 RESOLVED 再设成 RESOLVED"不会掩盖前端按钮状态错误。
 */
export function assertTransition(from: IncidentStatus, to: IncidentStatus): void {
  if (canTransition(from, to)) return;

  const allowed = INCIDENT_TRANSITIONS[from];
  throw new AppError(
    'INVALID_TRANSITION',
    allowed.length === 0
      ? `事件已${INCIDENT_STATUS_LABEL[from]}，不能再变更为${INCIDENT_STATUS_LABEL[to]}`
      : `事件不能从${INCIDENT_STATUS_LABEL[from]}变更为${INCIDENT_STATUS_LABEL[to]}`,
    {
      from,
      to,
      allowed,
      reason: allowed.length === 0 ? 'TERMINAL' : 'BACKWARD_OR_UNKNOWN',
    },
  );
}
