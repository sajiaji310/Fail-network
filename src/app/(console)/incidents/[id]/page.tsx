import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { IncidentWorkspace } from '@/components/domain/incident-workspace';
import { IncidentStatusPill, SeverityPill, TopologyPill } from '@/components/ui/badges';
import { PhaseProgress } from '@/components/ui/phase-progress';
import { absTime, duration, relTime } from '@/lib/utils/time';
import { getIncidentDetail } from '@/modules/incidents/detail';
import { RESPONSE_STATE_LABEL } from '@/modules/incidents/sla';
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

        <PhaseProgress phase={detail.phase} className="mt-2" />

        <dl className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1 text-[11px] text-text-secondary">
          <Meta
            label="负责人"
            value={
              detail.assignee ? (
                <span className="text-text">
                  {detail.assignee}
                  {detail.team ? (
                    <span className="ml-1 text-text-tertiary">{detail.team}</span>
                  ) : null}
                </span>
              ) : (
                <span className="text-warn">无人接手</span>
              )
            }
          />
          <Meta
            label="响应"
            value={
              <span
                className={
                  detail.response.state === 'BREACHED'
                    ? 'text-danger'
                    : detail.response.state === 'DUE_SOON'
                      ? 'text-warn'
                      : ''
                }
              >
                {RESPONSE_STATE_LABEL[detail.response.state]}
                {detail.response.claimSeconds !== null
                  ? `（${Math.max(1, Math.round(detail.response.claimSeconds / 60))} 分钟）`
                  : `（时限 ${detail.response.slaMinutes} 分钟）`}
              </span>
            }
          />
          <Meta
            label="业务"
            value={
              detail.services.length > 0 ? (
                <span className="text-text" title={detail.services.map((s) => s.name).join('、')}>
                  {detail.services.length} 个
                  {detail.services.some((s) => s.tier === 1) ? (
                    <span className="ml-1 text-danger">
                      {detail.services
                        .filter((s) => s.tier === 1)
                        .map((s) => s.name)
                        .join('、')}
                    </span>
                  ) : null}
                </span>
              ) : (
                <span className="text-text-tertiary">未命中已知服务</span>
              )
            }
          />
          <Meta
            label="开始"
            value={<span suppressHydrationWarning>{absTime(detail.startedAt)}</span>}
          />{' '}
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
