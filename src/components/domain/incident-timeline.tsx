import type { Severity } from '@prisma/client';
import { absTime, relTime } from '@/lib/utils/time';
import type { TimelineItem, TimelineKind } from '@/modules/incidents/timeline';
import { cn } from '@/lib/utils/cn';

/** 事件时间线（左栏）。纯展示，不持状态 */

const KIND_COLOR: Record<TimelineKind, string> = {
  INCIDENT: 'bg-primary',
  ALERT: 'bg-sev-p0',
  SUPPRESS: 'bg-text-tertiary',
  CHANGE: 'bg-accent',
};

const KIND_LABEL: Record<TimelineKind, string> = {
  INCIDENT: '事件',
  ALERT: '告警',
  SUPPRESS: '抑制',
  CHANGE: '变更',
};

const SEVERITY_TEXT: Record<Severity, string> = {
  P0: 'text-sev-p0',
  P1: 'text-sev-p1',
  P2: 'text-sev-p2',
  P3: 'text-sev-p3',
};

export type IncidentTimelineProps = {
  items: readonly TimelineItem[];
  total: number;
  truncated: boolean;
  selectedDeviceId?: string | null;
  onSelectDevice?: (deviceId: string) => void;
};

export function IncidentTimeline({
  items,
  total,
  truncated,
  selectedDeviceId = null,
  onSelectDevice,
}: IncidentTimelineProps) {
  if (items.length === 0) {
    return (
      <div className="rounded-[8px] border border-dashed border-border-strong px-3 py-8 text-center">
        <p className="text-[13px] font-medium text-text">事件还没有时间线</p>
        <p className="mt-1 text-[12px] text-text-tertiary">
          告警被聚合进事件后，这里会按时间顺序列出告警与变更。
        </p>
      </div>
    );
  }

  return (
    <ol className="relative space-y-0">
      {items.map((item, index) => {
        const dimmed =
          selectedDeviceId !== null && item.deviceId !== null && item.deviceId !== selectedDeviceId;
        return (
          <li key={item.id} className="relative flex gap-2.5 pb-3 pl-0.5">
            <div className="flex w-11 shrink-0 flex-col items-end pt-0.5">
              <time
                dateTime={item.at}
                title={absTime(item.at)}
                className="font-mono text-[10px] leading-4 text-text-tertiary"
                suppressHydrationWarning
              >
                {absTime(item.at).slice(11, 19)}
              </time>
              <span className="text-[10px] leading-4 text-text-tertiary" suppressHydrationWarning>
                {relTime(item.at)}
              </span>
            </div>

            <div className="relative flex w-3 shrink-0 justify-center">
              <span
                className={cn(
                  'mt-1 size-2 shrink-0 rounded-full',
                  KIND_COLOR[item.kind],
                  dimmed && 'opacity-30',
                )}
                aria-hidden
              />
              {index < items.length - 1 ? (
                <span className="absolute top-3 h-full w-px bg-border" aria-hidden />
              ) : null}
            </div>

            <div className={cn('min-w-0 flex-1 pb-1', dimmed && 'opacity-45')}>
              <div className="flex items-baseline gap-1.5">
                <span className="rounded-[3px] bg-surface-muted px-1 py-px text-[10px] text-text-tertiary">
                  {KIND_LABEL[item.kind]}
                </span>
                {item.deviceId && onSelectDevice ? (
                  <button
                    type="button"
                    onClick={() => onSelectDevice(item.deviceId!)}
                    className="truncate text-left text-[12px] font-medium text-text hover:text-primary hover:underline"
                  >
                    {item.title}
                  </button>
                ) : (
                  <span className="truncate text-[12px] font-medium text-text">{item.title}</span>
                )}
                {item.severity ? (
                  <span
                    className={cn(
                      'ml-auto shrink-0 font-mono text-[10px]',
                      SEVERITY_TEXT[item.severity],
                    )}
                  >
                    {item.severity}
                  </span>
                ) : null}
              </div>
              {item.detail ? (
                <p className="mt-0.5 line-clamp-2 text-[11px] leading-4 text-text-secondary">
                  {item.detail}
                </p>
              ) : null}
            </div>
          </li>
        );
      })}
      {truncated ? (
        <li className="pt-1 text-[11px] text-text-tertiary">
          仅显示最早 {items.length} 条，共 {total} 条
        </li>
      ) : null}
    </ol>
  );
}
