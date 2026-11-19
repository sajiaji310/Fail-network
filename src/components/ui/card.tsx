import { cn } from '@/lib/utils/cn';

/**
 * 卡片是这套界面的基本块：一层底色 + 一条发丝描边 + 两层阴影。
 *
 * 不用更重的高光/渐变：控制台里十几张卡同屏，任何一处"抢眼"都会让整体变吵。
 * 高级感靠的是三件事——描边足够淡、阴影足够散、内容四周留白足够稳。
 */
export function Card({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <section
      className={cn(
        'rounded-xl border border-border bg-surface p-5 shadow-card',
        'transition-shadow duration-200',
        className,
      )}
    >
      {children}
    </section>
  );
}

export function CardTitle({
  children,
  hint,
  action,
}: {
  children: React.ReactNode;
  hint?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-4 flex items-baseline justify-between gap-3">
      <h2 className="text-[15px] leading-6 font-semibold text-text">{children}</h2>
      {action ??
        (hint ? (
          <span className="font-mono text-[10.5px] tracking-wide text-text-tertiary">{hint}</span>
        ) : null)}
    </div>
  );
}
