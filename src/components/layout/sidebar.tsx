'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Activity,
  BellRing,
  BookOpen,
  Network,
  Settings,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils/cn';

type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  /** 未实现的路由标注所属任务卡，避免出现 404 死链 */
  pendingCard?: string;
};

const NAV: NavItem[] = [
  { href: '/overview', label: '概览', icon: Activity },
  { href: '/alerts', label: '告警流', icon: BellRing },
  { href: '/incidents', label: '事件', icon: TriangleAlert },
  { href: '/topology', label: '拓扑', icon: Network },
  { href: '/cases', label: '案例库', icon: BookOpen },
  { href: '/settings', label: '设置', icon: Settings, pendingCard: 'T09' },
];

export function Sidebar() {
  const pathname = usePathname();
  return (
    <aside className="flex w-[196px] shrink-0 flex-col border-r border-border bg-surface">
      <div className="flex h-14 items-center gap-2 border-b border-border px-4">
        <span className="grid size-6 place-items-center rounded-[6px] bg-primary text-[11px] font-medium text-text-inverse">
          NS
        </span>
        <span className="text-[15px] font-medium tracking-tight">NetScope</span>
      </div>

      <nav className="flex-1 px-2 py-3">
        <p className="px-2 pb-2 text-[11px] font-medium tracking-wider text-text-tertiary">
          控制台
        </p>
        <ul className="space-y-0.5">
          {NAV.map(({ href, label, icon: Icon, pendingCard }) => {
            const active = pathname === href || pathname.startsWith(`${href}/`);
            if (pendingCard) {
              return (
                <li key={href}>
                  <span
                    className="flex items-center gap-2.5 rounded-[6px] px-2 py-1.5 text-text-tertiary"
                    title={`尚未实现，见任务卡 ${pendingCard}`}
                  >
                    <Icon size={16} strokeWidth={1.5} />
                    <span className="text-[13px]">{label}</span>
                    <span className="ml-auto rounded-[4px] bg-surface-muted px-1.5 py-px font-mono text-[10px] text-text-tertiary">
                      {pendingCard}
                    </span>
                  </span>
                </li>
              );
            }
            return (
              <li key={href}>
                <Link
                  href={href}
                  className={cn(
                    'flex items-center gap-2.5 rounded-[6px] px-2 py-1.5 transition-colors',
                    active
                      ? 'bg-primary-soft font-medium text-primary'
                      : 'text-text-secondary hover:bg-surface-muted hover:text-text',
                  )}
                >
                  <Icon size={16} strokeWidth={1.5} />
                  <span className="text-[13px]">{label}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="border-t border-border px-3 py-3 text-[11px] leading-relaxed text-text-tertiary">
        <p className="font-mono">v0.1.0 · MVP-0</p>
        <p>单人 + Agent 协作基线</p>
      </div>
    </aside>
  );
}
