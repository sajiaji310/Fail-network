import Link from 'next/link';
import { cn } from '@/lib/utils/cn';

export type SegmentedTab = {
  key: string;
  label: string;
  href: string;
  /** 可选计数。给 undefined 就不显示，避免出现孤零零的 0 */
  count?: number;
};

/**
 * 分段筛选器（事件列表 / 告警流的共用件）。
 *
 * 用胶囊段落而不是下划线标签：下划线在浅底上只有 2px 的视觉重量，
 * 一屏里如果还有别的分割线就会糊成一片；段落靠"白色浮起 + 发丝环"表达选中，
 * 层级更硬，也更符合控制台"当前在哪一格"的读法。
 */
export function SegmentedTabs({
  items,
  activeKey,
  className,
}: {
  items: SegmentedTab[];
  activeKey: string;
  className?: string;
}) {
  return (
    <nav
      className={cn(
        'inline-flex items-center gap-0.5 rounded-[10px] border border-border bg-surface-muted/70 p-1',
        className,
      )}
    >
      {items.map((t) => {
        const active = t.key === activeKey;
        return (
          <Link
            key={t.key}
            href={t.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-[7px] px-3 py-1.5 text-[12.5px] transition-all duration-150',
              active
                ? 'bg-surface font-medium text-text shadow-pill ring-1 ring-border/60'
                : 'text-text-secondary hover:text-text',
            )}
          >
            {t.label}
            {t.count !== undefined ? (
              <span className="tabular font-mono text-[10px] text-text-tertiary">{t.count}</span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}
