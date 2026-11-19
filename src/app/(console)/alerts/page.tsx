import Link from 'next/link';
import type { AlertStatus } from '@prisma/client';
import { AlertTable } from '@/components/domain/alert-table';
import { SimulateButton } from '@/components/domain/simulate-button';
import { SegmentedTabs } from '@/components/ui/tabs';
import { buttonClass } from '@/components/ui/button';
import { listAlerts } from '@/modules/alerts/service';

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
          <h1 className="text-[22px] leading-7 font-semibold tracking-tight">告警流</h1>
          <p className="mt-0.5 text-[12px] text-text-secondary">
            归一化后的告警发生记录 · 同指纹 30 分钟内累加为一行 · 共 {list.total} 条
          </p>
        </div>
        <SimulateButton label="注入演示故障" variant="ghost" reset />
      </header>

      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <SegmentedTabs
          activeKey={tab.key}
          items={TABS.map((t) => ({
            key: t.key,
            label: t.label,
            href: t.key === 'all' ? '/alerts' : `/alerts?status=${t.key}`,
          }))}
        />
        <span className="text-[11px] text-text-tertiary">
          点设备名可筛选 · 点告警类型跳到所属事件
        </span>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border-strong bg-surface px-6 py-14 text-center">
          <p className="text-[14px] font-medium text-text">这个筛选下没有告警</p>
          <p className="mx-auto mt-1.5 max-w-[440px] text-[12px] leading-5 text-text-tertiary">
            告警来自上游系统导入或故障剧本注入。注入一套剧本会产生 12–22
            条告警，并按父子规则部分抑制。
          </p>
          <div className="mt-4 flex items-center justify-center gap-2">
            <SimulateButton label="注入演示故障" reset />
            <Link href="/alerts" className={buttonClass({ variant: 'secondary', size: 'sm' })}>
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
