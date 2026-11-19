import { cn } from '@/lib/utils/cn';

export type Tone = 'ok' | 'warn' | 'danger' | 'muted' | 'info';

/** 浅底 + 同色系发丝描边：比纯色块更像"标签"，也不会在白卡上糊成一片 */
const TONE_CLASS: Record<Tone, string> = {
  ok: 'bg-ok-soft text-ok ring-ok/18',
  warn: 'bg-warn-soft text-warn ring-warn/18',
  danger: 'bg-danger-soft text-danger ring-danger/18',
  info: 'bg-primary-soft text-info ring-info/15',
  muted: 'bg-surface-muted text-text-secondary ring-border',
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
        'inline-flex shrink-0 items-center gap-1.5 rounded-[6px] px-2 py-[2px] text-[11.5px] font-medium ring-1 ring-inset',
        TONE_CLASS[tone],
        className,
      )}
    >
      <span className={cn('size-[5px] rounded-full', DOT_CLASS[tone])} aria-hidden />
      {children}
    </span>
  );
}
