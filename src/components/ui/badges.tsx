import type { AlertStatus, IncidentStatus, Severity } from '@prisma/client';
import { StatusPill, type Tone } from './status-pill';

/** 严重度/状态徽标：色 + 文字双编码（文档 11.3），调用方不要自己拼颜色 */

const SEVERITY_TONE: Record<Severity, Tone> = {
  P0: 'danger',
  P1: 'warn',
  P2: 'info',
  P3: 'muted',
};

const SEVERITY_LABEL: Record<Severity, string> = {
  P0: 'P0 紧急',
  P1: 'P1 严重',
  P2: 'P2 一般',
  P3: 'P3 提示',
};

export function SeverityPill({ severity, compact }: { severity: Severity; compact?: boolean }) {
  return (
    <StatusPill
      tone={SEVERITY_TONE[severity]}
      className={compact ? 'px-1.5 py-0 text-[11px]' : undefined}
    >
      {compact ? severity : SEVERITY_LABEL[severity]}
    </StatusPill>
  );
}

const ALERT_STATUS_TONE: Record<AlertStatus, Tone> = {
  ACTIVE: 'danger',
  SUPPRESSED: 'muted',
  RESOLVED: 'ok',
};

const ALERT_STATUS_LABEL: Record<AlertStatus, string> = {
  ACTIVE: '活跃',
  SUPPRESSED: '已抑制',
  RESOLVED: '已恢复',
};

export function AlertStatusPill({ status }: { status: AlertStatus }) {
  return <StatusPill tone={ALERT_STATUS_TONE[status]}>{ALERT_STATUS_LABEL[status]}</StatusPill>;
}

const INCIDENT_STATUS_TONE: Record<IncidentStatus, Tone> = {
  OPEN: 'danger',
  ANALYZING: 'info',
  LOCATED: 'warn',
  MITIGATED: 'warn',
  RESOLVED: 'ok',
  CLOSED: 'muted',
};

const INCIDENT_STATUS_LABEL: Record<IncidentStatus, string> = {
  OPEN: '待处理',
  ANALYZING: '研判中',
  LOCATED: '已定位',
  MITIGATED: '已缓解',
  RESOLVED: '已恢复',
  CLOSED: '已归档',
};

export function IncidentStatusPill({ status }: { status: IncidentStatus }) {
  return (
    <StatusPill tone={INCIDENT_STATUS_TONE[status]}>{INCIDENT_STATUS_LABEL[status]}</StatusPill>
  );
}
