import Link from 'next/link';
import type { IncidentStatus, Severity } from '@prisma/client';
import { IncidentCard } from '@/components/domain/incident-card';
import { SimulateButton } from '@/components/domain/simulate-button';
import { SegmentedTabs } from '@/components/ui/tabs';
import { buttonClass } from '@/components/ui/button';
import { getIncidentStats, listIncidents } from '@/modules/incidents/service';

export const dynamic = 'force-dynamic';

type Tab = {
  key: string;
  label: string;
  status?: IncidentStatus[];
  severity?: Severity[];
};

const TABS: Tab[] = [
  {
    key: 'active',
    label: '活跃',
    status: ['OPEN', 'ANALYZING', 'LOCATED', 'MITIGATED'],
  },
  { key: 'closed', label: '已恢复', status: ['RESOLVED', 'CLOSED'] },
  { key: 'all', label: '全部' },
];

const DEFAULT_TAB = TABS[0] as Tab;

export default async function IncidentsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { status: statusParam } = await searchParams;
  const tab = TABS.find((t) => t.key === statusParam) ?? DEFAULT_TAB;

  const [list, stats] = await Promise.all([
    listIncidents({ status: tab.status, severity: tab.severity, page: 1, pageSize: 40 }),
    getIncidentStats(),
  ]);

  return (
    <div className="mx-auto max-w-[1180px]">
      <header className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[22px] leading-7 font-semibold tracking-tight">事件</h1>
          <p className="mt-0.5 text-[12px] text-text-secondary">
            告警按拓扑与时间聚合后的故障单元 · 共 {stats.total} 条，活跃 {stats.open} 条
          </p>
        </div>
        <SimulateButton label="注入演示故障" variant="ghost" reset />
      </header>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <SegmentedTabs
          activeKey={tab.key}
          items={TABS.map((t) => ({
            key: t.key,
            label: t.label,
            href: t.key === 'active' ? '/incidents' : `/incidents?status=${t.key}`,
            count:
              t.key === 'active' ? stats.open : t.key === 'closed' ? stats.closed : stats.total,
          }))}
        />
        <span className="text-[11px] text-text-tertiary">
          卡片左条为严重度 · 点进详情看研判结论
        </span>
      </div>

      {list.items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border-strong bg-surface px-6 py-14 text-center">
          <p className="text-[14px] font-medium text-text">
            {stats.total === 0 ? '还没有任何事件' : '当前筛选下没有事件'}
          </p>
          <p className="mx-auto mt-1.5 max-w-[420px] text-[12px] leading-5 text-text-tertiary">
            {stats.total === 0
              ? '事件由告警聚合产生。先注入一套故障剧本（22 条告警），系统会自动聚合出一个 P0 事件；也可以先去看拓扑确认设备基线。'
              : '切到「全部」看看，或注入一套新剧本制造一个活跃事件。'}
          </p>
          <div className="mt-4 flex items-center justify-center gap-2">
            <SimulateButton label="注入演示故障" reset />
            <Link
              href={stats.total === 0 ? '/topology' : '/incidents?status=all'}
              className={buttonClass({ variant: 'secondary', size: 'sm' })}
            >
              {stats.total === 0 ? '查看拓扑基线' : '查看全部事件'}
            </Link>
          </div>
        </div>
      ) : (
        <ul className="grid gap-3 lg:grid-cols-2">
          {list.items.map((incident) => (
            <li key={incident.id}>
              <IncidentCard incident={incident} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
