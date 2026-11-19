import type { AlertStatus, Severity } from '@prisma/client';
import { alertTypeLabel } from '@/modules/alerts/labels';

/**
 * 事件时间线合成（文档 11.1 `/incidents/[id]`：左栏时间线）。
 *
 * 为什么时间线要含变更记录：根因研判的第一类证据就是"故障前有人动过什么"。
 * 时间线只放告警的话，值班同学永远看不出 ACL 改错和 BGP 邻居 Down 的先后关系。
 *
 * 纯函数：不做 IO、不读时钟，输入相同输出必然相同，便于单测与快照。
 */

export type TimelineKind = 'INCIDENT' | 'ALERT' | 'SUPPRESS' | 'CHANGE';

export type TimelineItem = {
  id: string;
  /** ISO 字符串：要跨 RSC → Client 边界传，Date 不行 */
  at: string;
  kind: TimelineKind;
  title: string;
  detail: string | null;
  severity: Severity | null;
  deviceId: string | null;
  deviceName: string | null;
};

export type TimelineAlertInput = {
  id: string;
  type: string;
  severity: Severity;
  status: AlertStatus;
  message: string;
  count: number;
  firstSeen: Date;
  /** 最近一次上报时间；缺省时按 firstSeen 排序 */
  lastSeen?: Date;
  deviceId: string;
  deviceName: string;
  suppressedBy?: string | null;
};

export type TimelineChangeInput = {
  id: string;
  kind: string;
  content: string;
  operator: string | null;
  changedAt: Date;
  deviceId: string;
  deviceName: string;
};

export type TimelineInput = {
  incident: {
    id: string;
    code: string;
    title: string;
    startedAt: Date;
    lastSeen: Date;
    resolvedAt: Date | null;
  };
  alerts: readonly TimelineAlertInput[];
  changes: readonly TimelineChangeInput[];
};

const KIND_ORDER: Record<TimelineKind, number> = {
  INCIDENT: 0,
  CHANGE: 1,
  SUPPRESS: 2,
  ALERT: 3,
};

const CHANGE_KIND_LABEL: Record<string, string> = {
  CONFIG: '配置变更',
  FIRMWARE: '固件升级',
  HARDWARE: '硬件更换',
  CABLING: '布线调整',
};

export function changeKindLabel(kind: string): string {
  return CHANGE_KIND_LABEL[kind.trim().toUpperCase()] ?? kind;
}

export type TimelineResult = { items: TimelineItem[]; total: number; truncated: boolean };

export function buildTimeline(
  input: TimelineInput,
  options: { limit?: number } = {},
): TimelineResult {
  const limit = options.limit ?? 160;
  const items: TimelineItem[] = [];

  items.push({
    id: `incident-start-${input.incident.id}`,
    at: input.incident.startedAt.toISOString(),
    kind: 'INCIDENT',
    title: `事件生成 ${input.incident.code}`,
    detail: input.incident.title,
    severity: null,
    deviceId: null,
    deviceName: null,
  });

  for (const alert of input.alerts) {
    const suppressed = alert.status === 'SUPPRESSED';
    const at = alert.lastSeen ?? alert.firstSeen;
    items.push({
      id: `alert-${alert.id}`,
      at: (at > alert.firstSeen ? at : alert.firstSeen).toISOString(),
      kind: suppressed ? 'SUPPRESS' : 'ALERT',
      title: `${alert.deviceName} · ${alertTypeLabel(alert.type)}`,
      detail: suppressed
        ? `${alert.message}（被父告警抑制，不计入影响面）`
        : alert.count > 1
          ? `${alert.message}（累计 ${alert.count} 次）`
          : alert.message,
      severity: alert.severity,
      deviceId: alert.deviceId,
      deviceName: alert.deviceName,
    });
  }

  for (const change of input.changes) {
    items.push({
      id: `change-${change.id}`,
      at: change.changedAt.toISOString(),
      kind: 'CHANGE',
      title: `${change.deviceName} · ${changeKindLabel(change.kind)}`,
      detail: change.operator ? `${change.content}（操作人 ${change.operator}）` : change.content,
      severity: null,
      deviceId: change.deviceId,
      deviceName: change.deviceName,
    });
  }

  if (input.incident.resolvedAt) {
    items.push({
      id: `incident-resolved-${input.incident.id}`,
      at: input.incident.resolvedAt.toISOString(),
      kind: 'INCIDENT',
      title: '事件恢复',
      detail: null,
      severity: null,
      deviceId: null,
      deviceName: null,
    });
  }

  items.sort((a, b) => {
    const diff = Date.parse(a.at) - Date.parse(b.at);
    if (diff !== 0) return diff;
    const byKind = KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
    return byKind !== 0 ? byKind : a.id.localeCompare(b.id);
  });

  return {
    items: items.slice(0, limit),
    total: items.length,
    truncated: items.length > limit,
  };
}
