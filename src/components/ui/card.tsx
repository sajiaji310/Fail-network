import { cn } from '@/lib/utils/cn';

export function Card({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      className={cn(
        'rounded-[12px] border border-border bg-surface p-5 shadow-[0_1px_2px_rgba(16,24,40,0.06)]',
        className,
      )}
    >
      {children}
    </section>
  );
}

export function CardTitle({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <div className="mb-3 flex items-baseline justify-between gap-3">
      <h2 className="text-[16px] font-medium">{children}</h2>
      {hint ? <span className="font-mono text-[11px] text-text-tertiary">{hint}</span> : null}
    </div>
  );
}
