import Link from 'next/link';
import { format } from 'date-fns';
import { ArrowRight, Clock3, Sparkles, UserX } from 'lucide-react';
import { Card, CardTitle } from '@/components/ui/card';
import { StatusPill, type Tone } from '@/components/ui/status-pill';
import { RefreshButton } from '@/components/domain/refresh-button';
import { duration } from '@/lib/utils/time';
import { getAlertStats } from '@/modules/alerts/service';
import {
  getIncidentStats,
  listIncidents,
  type IncidentListItem,
} from '@/modules/incidents/service';
import { PHASE_LABEL, RESPONSE_STATE_LABEL } from '@/modules/incidents/sla';
import { getSystemStatus } from '@/modules/system/service';

export const dynamic = 'force-dynamic';

const SEVERITY_TONE: Record<string, Tone> = { P0: 'danger', P1: 'danger', P2: 'warn', P3: 'muted' };
const ACTIVE = ['OPEN', 'ANALYZING', 'LOCATED', 'MITIGATED'] as const;

/**
 * 概览 = 值班看板（评审 5.1：从"工程验收面板"转为"值班决策面板"）。
 *
 * 首屏只回答四个问题：有没有 P0/P1、哪些没人接手、哪些有结论等人拍板、
 * 哪些快到响应时限了。数据基线、评测基线、任务进度这些验收材料搬到
 * /settings —— 值班的人每天看它们没有用，验收的人需要时能找到就行。
 */
export default async function OverviewPage() {
  const [s, stats, alerts, unassigned, unanalyzed, awaiting, active] = await Promise.all([
    getSystemStatus(),
    getIncidentStats(),
    getAlertStats(),
    listIncidents({ queue: 'UNASSIGNED', page: 1, pageSize: 5 }),
    listIncidents({ queue: 'UNANALYZED', page: 1, pageSize: 5 }),
    listIncidents({ queue: 'AWAITING_CONFIRM', page: 1, pageSize: 5 }),
    listIncidents({ status: [...ACTIVE], page: 1, pageSize: 8 }),
  ]);

  const kpis: { label: string; value: number; hint: string; tone: Tone }[] = [
    {
      label: '活跃事件',
      value: stats.open,
      hint: `24h 新增 ${stats.last24h}`,
      tone: stats.open > 0 ? 'info' : 'ok',
    },
    {
      label: '未接手',
      value: stats.unassigned,
      hint: stats.unassigned > 0 ? '还没有责任人' : '全部有人负责',
      tone: stats.unassigned > 0 ? 'warn' : 'ok',
    },
    {
      label: '响应告急',
      value: stats.atRisk,
      hint:
        stats.breached > 0
          ? `其中 ${stats.breached} 个已超时（超时未接手）`
          : stats.atRisk > 0
            ? '剩余时间不足两成，先认领'
            : '全部在响应时限内',
      tone: stats.breached > 0 ? 'danger' : stats.atRisk > 0 ? 'warn' : 'ok',
    },
    {
      label: '待确认结论',
      value: stats.awaitingConfirm,
      hint: stats.awaitingConfirm > 0 ? '研判已出，等人拍板' : '没有积压',
      tone: stats.awaitingConfirm > 0 ? 'warn' : 'ok',
    },
  ];

  return (
    <div className="mx-auto max-w-[1100px]">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[22px] leading-7 font-semibold tracking-tight">值班看板</h1>
          <p className="mt-1 text-[12.5px] text-text-secondary">
            需要立即处理的事件 · 未接手 {stats.unassigned} · 超时 {stats.breached} · 待确认{' '}
            {stats.awaitingConfirm}
          </p>
        </div>
        <RefreshButton />
      </div>

      {s.db === 'down' ? (
        <div className="mb-4 rounded-xl border border-danger/25 bg-danger-soft px-4 py-3 text-[13px] text-danger">
          <p className="font-medium">数据库连接失败</p>
          <p className="mt-0.5 font-mono text-[12px] break-all opacity-80">{s.dbError}</p>
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {kpis.map((item) => (
          <Card key={item.label} className="p-4">
            <div className="flex items-start justify-between gap-2">
              <p className="text-[11.5px] text-text-tertiary">{item.label}</p>
              <StatusPill tone={item.tone} className="px-1.5 py-0 text-[10.5px]">
                {item.tone === 'ok' ? '正常' : item.tone === 'danger' ? '需要处理' : '关注'}
              </StatusPill>
            </div>
            <p className="tabular mt-2 font-mono text-[26px] leading-8">{item.value}</p>
            <p className="mt-0.5 text-[11px] text-text-tertiary">{item.hint}</p>
          </Card>
        ))}
      </div>

      <div className="mt-4 grid gap-3 lg:grid-cols-3">
        <QueueCard
          icon={<UserX size={12} strokeWidth={2} />}
          title="无人接手"
          hint="先认领再分析，别让单子飘着"
          items={unassigned.items}
          total={unassigned.total}
          queue="UNASSIGNED"
          tone="warn"
          emptyText="所有活跃事件都有人负责"
        />
        <QueueCard
          icon={<Sparkles size={12} strokeWidth={2} />}
          title="未研判"
          hint="还没有根因候选"
          items={unanalyzed.items}
          total={unanalyzed.total}
          queue="UNANALYZED"
          tone="info"
          emptyText="没有待研判的事件"
        />
        <QueueCard
          icon={<Clock3 size={12} strokeWidth={2} />}
          title="待确认"
          hint="有结论，等人拍板"
          items={awaiting.items}
          total={awaiting.total}
          queue="AWAITING_CONFIRM"
          tone="warn"
          emptyText="没有等待确认的结论"
        />
      </div>

      <Card className="mt-4">
        <CardTitle
          hint={`告警 ${alerts.active} 活跃 · ${alerts.suppressed} 抑制 · ${alerts.resolved} 已恢复`}
        >
          活跃事件
          <Link
            href="/incidents"
            className="ml-2 inline-flex items-center gap-0.5 text-[11px] font-normal text-primary hover:underline"
          >
            全部
            <ArrowRight size={10} strokeWidth={2} />
          </Link>
        </CardTitle>

        {active.items.length > 0 ? (
          <table className="w-full text-[12px]">
            <thead>
              <tr className="text-left text-[11px] text-text-tertiary">
                <th className="pb-1 font-normal">严重级</th>
                <th className="pb-1 font-normal">事件</th>
                <th className="pb-1 font-normal">负责人</th>
                <th className="pb-1 font-normal">响应</th>
                <th className="pb-1 font-normal">业务</th>
                <th className="pb-1 text-right font-normal">持续</th>
                <th className="pb-1 text-right font-normal">告警</th>
              </tr>
            </thead>
            <tbody>
              {active.items.map((item) => (
                <tr key={item.id} className="border-t border-border/70">
                  <td className="py-1.5">
                    <StatusPill tone={SEVERITY_TONE[item.severity] ?? 'muted'} className="px-1.5">
                      {item.severity}
                    </StatusPill>
                  </td>
                  <td className="py-1.5">
                    <Link href={`/incidents/${item.id}`} className="group block min-w-0">
                      <span className="text-text group-hover:text-primary">{item.title}</span>
                      <span className="ml-1.5 font-mono text-[10px] text-text-tertiary">
                        {item.code}
                      </span>
                    </Link>
                  </td>
                  <td className="py-1.5">
                    {item.assignee ? (
                      <span className="text-text-secondary">
                        {item.assignee}
                        {item.team ? (
                          <span className="ml-1 text-[10px] text-text-tertiary">{item.team}</span>
                        ) : null}
                      </span>
                    ) : (
                      <span className="text-warn">无人接手</span>
                    )}
                  </td>
                  <td className="py-1.5">
                    <ResponseTag item={item} />
                  </td>
                  <td className="py-1.5 text-[11px] text-text-secondary">
                    {item.services.total > 0 ? (
                      <span title={item.services.critical.join('、')}>
                        {item.services.total} 个
                        {item.services.critical.length > 0 ? (
                          <span className="ml-1 text-danger">{item.services.critical[0]}</span>
                        ) : null}
                      </span>
                    ) : (
                      <span className="text-text-tertiary">—</span>
                    )}
                  </td>
                  <td
                    className="tabular py-1.5 text-right font-mono text-[11px] text-text-secondary"
                    suppressHydrationWarning
                  >
                    {duration(
                      Math.max(0, Math.round((Date.now() - item.startedAt.getTime()) / 1000)),
                    )}
                  </td>
                  <td className="tabular py-1.5 text-right font-mono text-[11px] text-text-tertiary">
                    {item.alertCount}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="mt-2 text-[12px] text-text-tertiary">
            当前没有活跃事件。注入一个剧本（
            <code className="font-mono">/settings</code> 页有一键注入）后，5 分钟内 ≥ 3
            条关联告警会聚成一个事件。
          </p>
        )}
      </Card>

      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-text-tertiary">
        <span>
          数据库 {s.db === 'up' ? '已连接' : '不可用'} · AI 引擎{' '}
          {s.llm === 'fallback' ? '规则降级' : s.llm === 'live' ? 'LLM 在线' : 'Mock'} · Node{' '}
          {s.node}
        </span>
        <span className="ml-auto">
          数据基线、评测基线、任务进度已移至{' '}
          <Link href="/settings" className="text-primary hover:underline">
            设置
          </Link>
        </span>
      </div>
    </div>
  );
}

function ResponseTag({ item }: { item: IncidentListItem }) {
  const state = item.response.state;
  const tone: Tone = state === 'BREACHED' ? 'danger' : state === 'DUE_SOON' ? 'warn' : 'muted';
  const text =
    state === 'BREACHED'
      ? RESPONSE_STATE_LABEL.BREACHED
      : state === 'DUE_SOON'
        ? RESPONSE_STATE_LABEL.DUE_SOON
        : item.claimedAt
          ? `已响应`
          : `时限 ${item.response.slaMinutes}m`;

  return (
    <span className="inline-flex items-center gap-1">
      <StatusPill tone={tone} className="px-1.5">
        {text}
      </StatusPill>
      <span className="text-[10px] text-text-tertiary">{PHASE_LABEL[item.phase]}</span>
    </span>
  );
}

function QueueCard({
  icon,
  title,
  hint,
  items,
  total,
  queue,
  tone,
  emptyText,
}: {
  icon: React.ReactNode;
  title: string;
  hint: string;
  items: readonly IncidentListItem[];
  total: number;
  queue: 'UNASSIGNED' | 'UNANALYZED' | 'AWAITING_CONFIRM';
  tone: Tone;
  emptyText: string;
}) {
  return (
    <Card className="flex flex-col">
      <div className="flex items-baseline gap-1.5">
        <span className="text-text-tertiary">{icon}</span>
        <h2 className="text-[13px] font-medium">{title}</h2>
        <StatusPill tone={total > 0 ? tone : 'ok'} className="px-1.5 py-0 text-[10.5px]">
          {total}
        </StatusPill>
        <span className="ml-auto text-[10px] text-text-tertiary">{hint}</span>
      </div>

      {items.length > 0 ? (
        <ul className="mt-2 flex-1 divide-y divide-border/70">
          {items.map((item) => (
            <li key={item.id}>
              <Link
                href={`/incidents/${item.id}`}
                className="-mx-1 flex items-center gap-1.5 rounded-[4px] px-1 py-1.5 hover:bg-surface-muted"
              >
                <span className="font-mono text-[9.5px] text-text-tertiary">{item.severity}</span>
                <span className="min-w-0 flex-1 truncate text-[11.5px] text-text-secondary">
                  {item.title}
                </span>
                <span className="shrink-0 font-mono text-[9.5px] text-text-tertiary">
                  {format(item.startedAt, 'HH:mm')}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 flex-1 text-[11px] text-text-tertiary">{emptyText}</p>
      )}

      {total > items.length ? (
        <Link
          href={`/incidents?queue=${queue}`}
          className="mt-2 inline-flex items-center gap-0.5 text-[10.5px] text-primary hover:underline"
        >
          还有 {total - items.length} 个
          <ArrowRight size={9} strokeWidth={2} />
        </Link>
      ) : null}
    </Card>
  );
}
