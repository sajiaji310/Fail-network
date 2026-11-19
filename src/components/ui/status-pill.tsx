import { cn } from '@/lib/utils/cn';

export type Tone = 'ok' | 'warn' | 'danger' | 'muted' | 'info';

const TONE_CLASS: Record<Tone, string> = {
  ok: 'bg-[#ECFDF3] text-ok',
  warn: 'bg-[#FFFAEB] text-warn',
  danger: 'bg-[#FEF3F2] text-danger',
  info: 'bg-primary-soft text-info',
  muted: 'bg-surface-muted text-text-secondary',
};

const DOT_CLASS: Record<Tone, string> = {
  ok: 'bg-ok',
  warn: 'bg-warn',
  danger: 'bg-danger',
  info: 'bg-info',
  muted: 'bg-text-tertiary',
};

/** 严重度/状态双编码：色点 + 文字，不靠颜色单独传达信息（11.3） */
export function StatusPill({
  tone,
  children,
  className,
}: {
  tone: Tone;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-[6px] px-2 py-0.5 text-[12px] font-medium',
        TONE_CLASS[tone],
        className,
      )}
    >
      <span className={cn('size-1.5 rounded-full', DOT_CLASS[tone])} aria-hidden />
      {children}
    </span>
  );
}
