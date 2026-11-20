import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { IncidentWorkspace } from '@/components/domain/incident-workspace';
import { IncidentStatusPill, SeverityPill, TopologyPill } from '@/components/ui/badges';
import { absTime, duration, relTime } from '@/lib/utils/time';
import { getIncidentDetail } from '@/modules/incidents/detail';
import { getLatestReport } from '@/modules/report/service';
import { getTopologyGraph } from '@/modules/topology/service';

export const dynamic = 'force-dynamic';

/** 事件详情：三栏工作台由 IncidentWorkspace 承载，本页只做取数与页头 */
export default async function IncidentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [detail, topology, report] = await Promise.all([
    getIncidentDetail(id),
    getTopologyGraph(),
    getLatestReport(id),
  ]);
  if (!detail) notFound();

  const mttr = detail.mttrSeconds ?? detail.stats.durationSeconds;

  return (
    <div className="mx-auto max-w-[1500px]">
      <div className="mb-3">
        <Link
          href="/incidents"
          className="inline-flex items-center gap-1 text-[12px] text-text-secondary hover:text-text"
        >
          <ArrowLeft size={13} strokeWidth={1.5} />
          返回事件列表
        </Link>
      </div>

      <header className="mb-4 rounded-xl border border-border bg-surface shadow-card px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[12px] text-text-tertiary">{detail.code}</span>
          <SeverityPill severity={detail.severity} />
          <IncidentStatusPill status={detail.status} />
          <TopologyPill level={detail.topology.level} />
          {detail.reopenedCount > 0 ? (
            <span className="rounded-[4px] bg-warn-soft px-1.5 py-px text-[11px] text-warn">
              重开 {detail.reopenedCount} 次
            </span>
          ) : null}
          {detail.mergedIntoId ? (
            <Link
              href={`/incidents/${detail.mergedIntoId}`}
              className="rounded-[4px] bg-surface-muted px-1.5 py-px text-[11px] text-text-secondary hover:text-primary"
            >
              已并入其它事件，查看目标 →
            </Link>
          ) : null}
          <span className="ml-auto text-[11px] text-text-tertiary" suppressHydrationWarning>
            最近告警 {relTime(detail.lastSeen)}
          </span>
        </div>

        <h1 className="mt-1.5 text-[19px] font-medium leading-7 tracking-tight">{detail.title}</h1>

        <dl className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1 text-[11px] text-text-secondary">
          <Meta
            label="开始"
            value={<span suppressHydrationWarning>{absTime(detail.startedAt)}</span>}
          />
          <Meta
            label={detail.resolvedAt ? 'MTTR' : '持续'}
            value={<span className="font-mono tabular">{duration(mttr)}</span>}
          />
          <Meta
            label="告警"
            value={
              <span className="font-mono tabular">
                {detail.stats.alertCount}
                {detail.stats.suppressedCount > 0 ? (
                  <span className="text-text-tertiary">
                    （{detail.stats.suppressedCount} 抑制）
                  </span>
                ) : null}
              </span>
            }
          />
          <Meta
            label="设备"
            value={<span className="font-mono tabular">{detail.stats.deviceCount}</span>}
          />
          <Meta
            label="变更"
            value={
              <span className={detail.stats.changeCount > 0 ? 'font-mono text-warn' : 'font-mono'}>
                {detail.stats.changeCount}
              </span>
            }
          />
          {detail.summary ? (
            <Meta label="结论" value={<span className="text-text">{detail.summary}</span>} />
          ) : null}
        </dl>
      </header>

      <IncidentWorkspace detail={detail} topology={topology} report={report} />
    </div>
  );
}

function Meta({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <dt className="text-text-tertiary">{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
