import Link from 'next/link';
import type { AlertStatus } from '@prisma/client';
import { AlertTable } from '@/components/domain/alert-table';
import { SimulateButton } from '@/components/domain/simulate-button';
import { listAlerts } from '@/modules/alerts/service';
import { cn } from '@/lib/utils/cn';

export const dynamic = 'force-dynamic';

const TABS: { key: string; label: string; status?: AlertStatus[] }[] = [
  { key: 'all', label: '全部' },
  { key: 'active', label: '活跃', status: ['ACTIVE'] },
  { key: 'suppressed', label: '已抑制', status: ['SUPPRESSED'] },
  { key: 'resolved', label: '已恢复', status: ['RESOLVED'] },
];

export default async function AlertsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { status: statusParam } = await searchParams;
  const tab = TABS.find((t) => t.key === statusParam) ?? (TABS[0] as (typeof TABS)[number]);

  const list = await listAlerts({ status: tab.status, page: 1, pageSize: 100 });

  const rows = list.items.map((item) => ({
    id: item.id,
    type: item.type,
    severity: item.severity,
    status: item.status,
    message: item.message,
    count: item.count,
    firstSeen: item.firstSeen.toISOString(),
    lastSeen: item.lastSeen.toISOString(),
    deviceId: item.deviceId,
    deviceName: item.deviceName,
    incidentId: item.incidentId,
  }));

  return (
    <div className="mx-auto max-w-[1320px]">
      <header className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[20px] font-medium tracking-tight">告警流</h1>
          <p className="mt-0.5 text-[12px] text-text-secondary">
            归一化后的告警发生记录 · 同指纹 30 分钟内累加为一行 · 共 {list.total} 条
          </p>
        </div>
        <SimulateButton label="注入演示故障" variant="ghost" reset />
      </header>

      <nav className="mb-3 flex items-center gap-1 border-b border-border">
        {TABS.map((t) => {
          const active = t.key === tab.key;
          return (
            <Link
              key={t.key}
              href={t.key === 'all' ? '/alerts' : `/alerts?status=${t.key}`}
              className={cn(
                'relative -mb-px border-b-2 px-3 py-2 text-[13px] transition-colors',
                active
                  ? 'border-primary font-medium text-primary'
                  : 'border-transparent text-text-secondary hover:text-text',
              )}
            >
              {t.label}
            </Link>
          );
        })}
        <span className="ml-auto pb-2 text-[11px] text-text-tertiary">
          点设备名可筛选 · 点告警类型跳到所属事件
        </span>
      </nav>

      {rows.length === 0 ? (
        <div className="rounded-[12px] border border-dashed border-border-strong bg-surface px-6 py-14 text-center">
          <p className="text-[14px] font-medium text-text">这个筛选下没有告警</p>
          <p className="mx-auto mt-1.5 max-w-[440px] text-[12px] leading-5 text-text-tertiary">
            告警来自上游系统导入或故障剧本注入。注入一套剧本会产生 12–22
            条告警，并按父子规则部分抑制。
          </p>
          <div className="mt-4 flex items-center justify-center gap-2">
            <SimulateButton label="注入演示故障" reset />
            <Link
              href="/alerts"
              className="inline-flex h-8 items-center rounded-[6px] border border-border-strong bg-surface px-3 text-[12px] font-medium text-text-secondary hover:bg-surface-muted hover:text-text"
            >
              查看全部告警
            </Link>
          </div>
        </div>
      ) : (
        <AlertTable
          rows={rows}
          incidentHrefOf={(row) => (row.incidentId ? `/incidents/${row.incidentId}` : null)}
        />
      )}
    </div>
  );
}
