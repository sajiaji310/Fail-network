import Link from 'next/link';
import type { Severity } from '@prisma/client';
import { IncidentStatusPill, SeverityPill } from '@/components/ui/badges';
import { absTime, duration, relTime } from '@/lib/utils/time';
import type { IncidentListItem } from '@/modules/incidents/service';
import { PHASE_LABEL } from '@/modules/incidents/sla';
import { cn } from '@/lib/utils/cn';

/** 事件列表卡片（文档 11.1 `/incidents`：卡片列表 + 严重度色条） */

const BAR_COLOR: Record<Severity, string> = {
  P0: 'bg-sev-p0',
  P1: 'bg-sev-p1',
  P2: 'bg-sev-p2',
  P3: 'bg-sev-p3',
};

function Dot() {
  return <span className="size-[3px] shrink-0 rounded-full bg-border-strong" aria-hidden />;
}

export function IncidentCard({ incident }: { incident: IncidentListItem }) {
  const devNames = incident.deviceNames.slice(0, 3).join('、');
  const rest = incident.deviceNames.length - 3;

  return (
    <Link
      href={`/incidents/${incident.id}`}
      className={cn(
        'group relative flex h-full flex-col gap-2 overflow-hidden rounded-xl border border-border bg-surface py-3.5 pr-4 pl-4.5',
        'shadow-card transition-all duration-200',
        'hover:-translate-y-px hover:border-border-strong/90 hover:shadow-raised',
      )}
    >
      <span
        className={cn('absolute inset-y-0 left-0 w-[3px]', BAR_COLOR[incident.severity])}
        aria-hidden
      />

      <div className="flex items-center gap-2">
        <span className="font-mono text-[11px] text-text-tertiary">{incident.code}</span>
        <SeverityPill severity={incident.severity} compact />
        <IncidentStatusPill status={incident.status} />
        <span className="ml-auto font-mono text-[11px] text-text-tertiary" suppressHydrationWarning>
          {relTime(incident.startedAt)}
        </span>
      </div>

      <h3 className="line-clamp-1 text-[14px] font-medium text-text transition-colors group-hover:text-primary">
        {incident.title}
      </h3>

      <div className="mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11.5px] text-text-secondary">
        <span className="inline-flex items-baseline gap-1">
          告警 <span className="tabular font-mono text-text">{incident.alertCount}</span>
        </span>
        <Dot />
        <span className="inline-flex items-baseline gap-1">
          设备 <span className="tabular font-mono text-text">{incident.deviceCount}</span>
        </span>
        {incident.resolvedAt && incident.mttrSeconds !== null ? (
          <>
            <Dot />
            <span className="inline-flex items-baseline gap-1">
              MTTR{' '}
              <span className="tabular font-mono text-text">{duration(incident.mttrSeconds)}</span>
            </span>
          </>
        ) : null}
        {incident.reopenedCount > 0 ? (
          <>
            <Dot />
            <span className="text-warn">重开 {incident.reopenedCount} 次</span>
          </>
        ) : null}
      </div>

      {devNames ? (
        <p
          className="line-clamp-1 font-mono text-[11px] text-text-tertiary"
          title={incident.deviceNames.join('、')}
        >
          {devNames}
          {rest > 0 ? ` 等 ${incident.deviceNames.length} 台` : ''}
        </p>
      ) : null}

      {/* 值班视角：谁在管、到哪一步了、波及哪几个业务 —— 这三件事比设备名更该先看到 */}
      <div className="mt-auto flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-border/70 pt-1.5 text-[11px]">
        <span className={incident.assignee ? 'text-text-secondary' : 'text-warn'}>
          {incident.assignee
            ? `${incident.assignee}${incident.team ? ` · ${incident.team}` : ''}`
            : '无人接手'}
        </span>
        {incident.assignee ? (
          <>
            <Dot />
            <span className="text-text-tertiary">{PHASE_LABEL[incident.phase]}</span>
          </>
        ) : null}
        {incident.response.state === 'BREACHED' ? (
          <span className="text-danger">已超响应时限</span>
        ) : incident.response.state === 'DUE_SOON' ? (
          <span className="text-warn">即将超时</span>
        ) : null}
        {incident.services.total > 0 ? (
          <span
            className="ml-auto text-text-tertiary"
            title={
              incident.services.critical.length > 0 ? incident.services.critical.join('、') : ''
            }
          >
            业务 {incident.services.total}
            {incident.services.critical.length > 0 ? (
              <span className="ml-1 text-danger">{incident.services.critical[0]}</span>
            ) : null}
          </span>
        ) : null}
      </div>

      <span className="sr-only">开始于 {absTime(incident.startedAt)}</span>
    </Link>
  );
}
