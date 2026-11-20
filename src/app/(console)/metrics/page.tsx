import Link from 'next/link';
import { Activity, Clock3, ShieldCheck, ShieldX, TriangleAlert } from 'lucide-react';
import { duration } from '@/lib/utils/time';
import { percent } from '@/lib/utils/number';
import { defaultWindow, getOpsMetrics } from '@/modules/ops/metrics';
import { cn } from '@/lib/utils/cn';

export const dynamic = 'force-dynamic';

/**
 * 运行指标（评审第 4 阶段「在真实事件上测量 MTTR、人工接受率和误抑制成本」）。
 *
 * 这一页只回答一个问题：**这套系统在真实数据上到底跑得怎么样**。
 * 所以每个数字下面都写清口径与分母 —— 没有分母的百分比是修辞，不是指标。
 */
export default async function MetricsPage() {
  const metrics = await getOpsMetrics(defaultWindow(30));
  const { incidents, acceptance, suppression, dataSources } = metrics;

  const cards = [
    {
      key: 'p50',
      label: 'MTTR 中位数',
      value: incidents.mttrSeconds.p50 === null ? '—' : duration(incidents.mttrSeconds.p50),
      hint: `近 ${metrics.window.days} 天已结案 ${incidents.closed} 个事件`,
      icon: Clock3,
      tone: 'text-text',
    },
    {
      key: 'p90',
      label: 'MTTR P90',
      value: incidents.mttrSeconds.p90 === null ? '—' : duration(incidents.mttrSeconds.p90),
      hint:
        incidents.mttrSeconds.avg === null
          ? '还没有含 MTTR 的结案记录'
          : `平均值 ${duration(incidents.mttrSeconds.avg)}（易被长尾拉偏，仅参考）`,
      icon: Activity,
      tone: 'text-text',
    },
    {
      key: 'acceptance',
      label: '人工接受率',
      value: acceptance.rate === null ? '—' : percent(acceptance.rate),
      hint:
        acceptance.decided === 0
          ? '还没有人裁决过假设'
          : `${acceptance.accepted} 采纳 / ${acceptance.decided} 已裁决`,
      icon: ShieldCheck,
      tone: acceptance.rate !== null && acceptance.rate >= 0.6 ? 'text-ok' : 'text-warn',
    },
    {
      key: 'suppression',
      label: '误抑制率',
      value: suppression.rate === null ? '—' : percent(suppression.rate),
      hint:
        suppression.suppressed === 0
          ? '窗口内没有被抑制的告警'
          : `${suppression.wrong} / ${suppression.suppressed} 条压制后父告警先恢复`,
      icon: suppression.wrong > 0 ? ShieldX : ShieldCheck,
      tone: suppression.wrong > 0 ? 'text-danger' : 'text-ok',
    },
  ];

  return (
    <div className="mx-auto max-w-[1180px]">
      <header className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[22px] leading-7 font-semibold tracking-tight">运行指标</h1>
          <p className="mt-0.5 text-[12px] text-text-secondary">
            近 {metrics.window.days} 天 · 新建 {incidents.created} 个事件，结案 {incidents.closed}{' '}
            个{incidents.reopened > 0 ? `，其中 ${incidents.reopened} 个重开过` : ''}
          </p>
        </div>
        <Link href="/sources" className="text-[11.5px] text-primary hover:underline">
          数据源与批次 →
        </Link>
      </header>

      <div className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {cards.map((card) => {
          const Icon = card.icon;
          return (
            <div
              key={card.key}
              className="rounded-xl border border-border bg-surface px-3.5 py-3 shadow-card"
            >
              <div className="flex items-center gap-1.5 text-[11px] text-text-tertiary">
                <Icon size={12} strokeWidth={1.8} />
                {card.label}
              </div>
              <p className={cn('mt-1 font-mono text-[22px] leading-7 font-semibold', card.tone)}>
                {card.value}
              </p>
              <p className="mt-0.5 text-[10.5px] leading-4 text-text-tertiary">{card.hint}</p>
            </div>
          );
        })}
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <section className="rounded-xl border border-border bg-surface p-3.5 shadow-card">
          <h2 className="flex items-center gap-1.5 text-[12.5px] font-medium">
            <TriangleAlert size={13} strokeWidth={1.8} className="text-text-tertiary" />
            数据接入
          </h2>
          <dl className="mt-2 grid grid-cols-2 gap-2">
            <Stat label="导入批次" value={dataSources.batches} />
            <Stat
              label="真实源告警"
              value={dataSources.realAlerts}
              hint="externalKey 带 am:/zbx:"
            />
            <Stat label="模拟/导入告警" value={dataSources.simulatedAlerts} />
            <Stat label="指标采样点" value={dataSources.metricSamples} />
          </dl>
          {dataSources.byKind.length > 0 ? (
            <table className="mt-2.5 w-full text-[11px]">
              <thead className="text-[10px] tracking-wide text-text-tertiary uppercase">
                <tr>
                  <th className="py-1 text-left font-medium">适配器</th>
                  <th className="py-1 text-right font-medium">批次</th>
                  <th className="py-1 text-right font-medium">入库</th>
                  <th className="py-1 text-right font-medium">失败</th>
                </tr>
              </thead>
              <tbody>
                {dataSources.byKind.map((row) => (
                  <tr key={row.kind} className="border-t border-border">
                    <td className="py-1 font-mono text-[10.5px]">{row.kind}</td>
                    <td className="py-1 text-right font-mono text-[10.5px]">{row.batches}</td>
                    <td className="py-1 text-right font-mono text-[10.5px]">{row.accepted}</td>
                    <td
                      className={cn(
                        'py-1 text-right font-mono text-[10.5px]',
                        row.failed > 0 ? 'text-danger' : 'text-text-tertiary',
                      )}
                    >
                      {row.failed}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="mt-2 text-[10.5px] leading-4 text-text-tertiary">
              还没有接入记录。去{' '}
              <Link href="/sources" className="text-primary hover:underline">
                数据源
              </Link>{' '}
              页按示例 curl 推一条。
            </p>
          )}
        </section>

        <section className="rounded-xl border border-border bg-surface p-3.5 shadow-card">
          <h2 className="text-[12.5px] font-medium">口径</h2>
          <ul className="mt-2 space-y-2 text-[11px] leading-[1.6] text-text-secondary">
            <li>
              <span className="text-text">MTTR</span>：结案时写入的{' '}
              <code className="font-mono text-[10px]">mttrSeconds</code>，取 p50 / p90。用分位而不是
              均值，是因为一次跨夜故障就能把平均值拉得没有意义。
            </li>
            <li>
              <span className="text-text">人工接受率</span>：已裁决假设里 ACCEPTED 的占比。分母只算
              「人真的点了按钮」的假设 —— 没人看过的不该稀释这个数。
            </li>
            <li>
              <span className="text-text">误抑制率</span>
              ：被压制的告警中，父告警已经恢复、它自己还在报
              的比例。父告警恢复后压制理由就消失了，这类告警会推迟独立故障被发现的时间。
            </li>
            <li>
              <span className="text-text">真实源告警</span>：来自 Prometheus / Zabbix 适配器的告警
              （按 externalKey 前缀识别），与剧本注入、CSV 导入区分开。
            </li>
          </ul>
          <p className="mt-2.5 rounded-[6px] bg-surface-muted px-2 py-1.5 text-[10.5px] leading-4 text-text-tertiary">
            这些数字只有在真实数据上才有意义：剧本里的事件时长是编排出来的，MTTR 自然漂亮。
          </p>
        </section>
      </div>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <div className="rounded-[8px] bg-surface-muted px-2 py-1.5">
      <dt className="text-[10px] text-text-tertiary" title={hint}>
        {label}
      </dt>
      <dd className="font-mono text-[15px] font-medium">{value}</dd>
    </div>
  );
}
