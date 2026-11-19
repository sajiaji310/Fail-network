import { cn } from '@/lib/utils/cn';

/**
 * 按钮样式唯一入口。
 *
 * 之前八个地方各写了一串：有的 h-8 有的 h-9、有的带阴影有的不带、有的 hover 换底色
 * 有的只换边框 —— 换个主色得改八处，而且改不完全就会一半新一半旧。
 *
 * 这里只导出 className，不导出组件：调用方有时是 <button>、有时是 <Link>，
 * 强行包一层反而要为两者各开一套 props。
 */

export type ButtonVariant = 'primary' | 'secondary' | 'ghost';
export type ButtonSize = 'md' | 'sm';

const BASE =
  'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-[8px] font-medium whitespace-nowrap ' +
  'transition-all duration-150 active:translate-y-px disabled:pointer-events-none disabled:opacity-55 ' +
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary';

const VARIANT: Record<ButtonVariant, string> = {
  // 主操作：微弱的上浅下深渐变 + 顶部 1px 高光，按下时不再变形
  primary:
    'bg-linear-to-b from-primary to-primary-hover text-text-inverse ' +
    'shadow-[inset_0_1px_0_rgba(255,255,255,0.16),0_1px_2px_rgba(15,23,42,0.18)] ' +
    'hover:brightness-[1.06]',
  secondary:
    'border border-border-strong bg-surface text-text-secondary shadow-pill ' +
    'hover:border-text-tertiary/50 hover:text-text',
  ghost: 'text-text-secondary hover:bg-surface-muted hover:text-text',
};

const SIZE: Record<ButtonSize, string> = {
  md: 'h-9 px-3.5 text-[12.5px]',
  sm: 'h-8 px-3 text-[12px]',
};

export function buttonClass({
  variant = 'secondary',
  size = 'md',
  className,
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
} = {}): string {
  return cn(BASE, VARIANT[variant], SIZE[size], className);
}
