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
};

const NAV: NavItem[] = [
  { href: '/overview', label: '概览', icon: Activity },
  { href: '/alerts', label: '告警流', icon: BellRing },
  { href: '/incidents', label: '事件', icon: TriangleAlert },
  { href: '/topology', label: '拓扑', icon: Network },
  { href: '/cases', label: '案例库', icon: BookOpen },
  { href: '/settings', label: '设置', icon: Settings },
];

export function Sidebar() {
  const pathname = usePathname();
  return (
    <aside className="sticky top-0 flex h-screen w-[204px] shrink-0 flex-col border-r border-border bg-surface/72 backdrop-blur-xl">
      <div className="flex h-14 items-center gap-2.5 px-4">
        <span className="grid size-7 place-items-center rounded-[9px] bg-linear-to-b from-primary to-primary-hover text-[11px] font-semibold text-text-inverse shadow-[inset_0_1px_0_rgba(255,255,255,0.22),0_1px_2px_rgba(15,23,42,0.18)]">
          NS
        </span>
        <span className="text-[15px] font-semibold tracking-tight">NetScope</span>
      </div>

      <nav className="flex-1 px-2.5 py-2">
        <p className="px-2 pb-2 text-[10px] font-medium tracking-[0.12em] text-text-tertiary uppercase">
          控制台
        </p>
        <ul className="space-y-0.5">
          {NAV.map(({ href, label, icon: Icon }) => {
            const active = pathname === href || pathname.startsWith(`${href}/`);
            return (
              <li key={href}>
                <Link
                  href={href}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'group relative flex items-center gap-2.5 rounded-[8px] px-2 py-[7px] text-[13px] transition-colors duration-150',
                    active
                      ? 'bg-surface font-medium text-primary shadow-pill ring-1 ring-border/70'
                      : 'text-text-secondary hover:bg-surface/80 hover:text-text',
                  )}
                >
                  {active ? (
                    <span
                      className="absolute top-1/2 -left-2.5 h-4 w-[2px] -translate-y-1/2 rounded-r-full bg-primary"
                      aria-hidden
                    />
                  ) : null}
                  <Icon
                    size={16}
                    strokeWidth={1.6}
                    className={
                      active ? 'text-primary' : 'text-text-tertiary group-hover:text-text-secondary'
                    }
                  />
                  <span>{label}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="border-t border-border px-4 py-3 text-[10.5px] leading-relaxed text-text-tertiary">
        <p className="font-mono">v0.1.0 · MVP-0</p>
        <p>单人 + Agent 协作基线</p>
      </div>
    </aside>
  );
}
