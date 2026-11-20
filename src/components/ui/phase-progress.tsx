import { cn } from '@/lib/utils/cn';
import { PHASE_LABEL, PHASE_ORDER, type IncidentPhase } from '@/modules/incidents/sla';

/**
 * 阶段进度条（评审 5.2「顶部明确展示当前阶段」）。
 *
 * 只做展示：阶段由状态 + 责任人 + 结论派生，不接受点击跳阶段 ——
 * 阶段不是可编辑字段，能改阶段的只有状态机那张表。
 */
export function PhaseProgress({ phase, className }: { phase: IncidentPhase; className?: string }) {
  const current = PHASE_ORDER.indexOf(phase);

  return (
    <ol className={cn('flex items-center gap-1.5', className)} aria-label="事件阶段">
      {PHASE_ORDER.map((item, index) => {
        const done = index < current;
        const active = index === current;
        return (
          <li key={item} className="flex items-center gap-1.5">
            {index > 0 ? (
              <span
                aria-hidden
                className={cn(
                  'h-px w-3 shrink-0 sm:w-5',
                  done || active ? 'bg-ok/60' : 'bg-border',
                )}
              />
            ) : null}
            <span
              className={cn(
                'inline-flex items-center gap-1 text-[10.5px] whitespace-nowrap',
                active ? 'font-medium text-text' : done ? 'text-ok' : 'text-text-tertiary',
              )}
              aria-current={active ? 'step' : undefined}
            >
              <span
                aria-hidden
                className={cn(
                  'size-1.5 rounded-full',
                  active
                    ? 'bg-primary ring-2 ring-primary/20'
                    : done
                      ? 'bg-ok'
                      : 'bg-border-strong',
                )}
              />
              {PHASE_LABEL[item]}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
