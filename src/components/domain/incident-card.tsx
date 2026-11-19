import Link from 'next/link';
import type { Severity } from '@prisma/client';
import { IncidentStatusPill, SeverityPill } from '@/components/ui/badges';
import { absTime, duration, relTime } from '@/lib/utils/time';
import type { IncidentListItem } from '@/modules/incidents/service';
import { cn } from '@/lib/utils/cn';

/** 事件列表卡片（文档 11.1 `/incidents`：卡片列表 + 严重度色条） */

const BAR_COLOR: Record<Severity, string> = {
  P0: 'bg-sev-p0',
  P1: 'bg-sev-p1',
  P2: 'bg-sev-p2',
  P3: 'bg-sev-p3',
};

export function IncidentCard({ incident }: { incident: IncidentListItem }) {
  const devNames = incident.deviceNames.slice(0, 3).join('、');
  const rest = incident.deviceNames.length - 3;

  return (
    <Link
      href={`/incidents/${incident.id}`}
      className={cn(
        'group relative flex flex-col gap-2 overflow-hidden rounded-[10px] border border-border bg-surface py-3 pl-4 pr-4',
        'shadow-[0_1px_2px_rgba(16,24,40,0.06)] transition-colors hover:border-border-strong',
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

      <h3 className="line-clamp-1 text-[14px] font-medium text-text group-hover:text-primary">
        {incident.title}
      </h3>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-text-secondary">
        <span>
          告警 <span className="font-mono tabular">{incident.alertCount}</span>
        </span>
        <span className="text-border-strong">|</span>
        <span>
          设备 <span className="font-mono tabular">{incident.deviceCount}</span>
        </span>
        {incident.resolvedAt && incident.mttrSeconds !== null ? (
          <>
            <span className="text-border-strong">|</span>
            <span>MTTR {duration(incident.mttrSeconds)}</span>
          </>
        ) : null}
        {incident.reopenedCount > 0 ? (
          <>
            <span className="text-border-strong">|</span>
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

      <span className="sr-only">开始于 {absTime(incident.startedAt)}</span>
    </Link>
  );
}
