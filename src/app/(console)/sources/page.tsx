import { Activity, Cable, CheckCircle2, CircleAlert, Clock3, Waypoints } from 'lucide-react';
import { AliasForm } from '@/components/domain/alias-form';
import { absTime, relTime } from '@/lib/utils/time';
import { getSourceOverview } from '@/modules/sources/service';
import { cn } from '@/lib/utils/cn';

export const dynamic = 'force-dynamic';

const STATUS_STYLE: Record<
  string,
  { label: string; className: string; icon: typeof CheckCircle2 }
> = {
  DONE: { label: '完成', className: 'bg-ok-soft text-ok', icon: CheckCircle2 },
  RUNNING: { label: '进行中', className: 'bg-primary-soft text-primary', icon: Activity },
  QUEUED: { label: '排队', className: 'bg-surface-muted text-text-secondary', icon: Clock3 },
  FAILED: { label: '失败', className: 'bg-danger-soft text-danger', icon: CircleAlert },
};

/**
 * 数据源（评审第 4 阶段「接入真实数据源 + 批处理导入」）。
 *
 * 页面结构跟着用户的接入顺序走：先看"往哪推"，再看"推进来的主机名认成了谁"，
 * 最后看"最近几批跑得怎么样"。三块缺一块，接入就会卡在某个说不清的环节上。
 */
export default async function SourcesPage() {
  const overview = await getSourceOverview();
  const { stats } = overview;

  return (
    <div className="mx-auto max-w-[1180px]">
      <header className="mb-4">
        <h1 className="text-[22px] leading-7 font-semibold tracking-tight">数据源</h1>
        <p className="mt-0.5 text-[12px] text-text-secondary">
          {stats.devices} 台设备 · {stats.aliasedDevices} 台配了别名（{stats.aliases} 条） ·{' '}
          {stats.lastBatchAt ? `最近一次导入 ${relTime(stats.lastBatchAt)}` : '还没有导入记录'}
        </p>
      </header>

      <section className="mb-6">
        <h2 className="mb-2 flex items-center gap-1.5 text-[13px] font-medium">
          <Waypoints size={14} strokeWidth={1.8} className="text-text-tertiary" />
          推送地址
        </h2>
        <div className="grid gap-3 lg:grid-cols-3">
          {overview.endpoints.map((endpoint) => (
            <article
              key={endpoint.kind}
              className="flex flex-col rounded-xl border border-border bg-surface p-3.5 shadow-card"
            >
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-[12.5px] font-medium">{endpoint.label}</h3>
                <span className="rounded-[3px] bg-surface-muted px-1 py-px font-mono text-[9.5px] text-text-secondary">
                  {endpoint.method}
                </span>
              </div>
              <code className="mt-1.5 block break-all font-mono text-[10.5px] leading-4 text-primary">
                {endpoint.path}
              </code>
              <pre className="mt-2 flex-1 overflow-x-auto rounded-[6px] bg-surface-muted px-2 py-1.5 font-mono text-[9.5px] leading-[1.5] text-text-secondary">
                {endpoint.sample}
              </pre>
              <p className="mt-2 text-[10.5px] leading-4 text-text-tertiary">{endpoint.note}</p>
            </article>
          ))}
        </div>
        <p className="mt-2 text-[10.5px] text-text-tertiary">
          生产环境需要 <code className="font-mono">x-api-key</code>（写接口要求 RESPONDER
          以上角色）。 超过 500 行的推送会转成异步批次，接口返回 202 与{' '}
          <code className="font-mono">batchId</code>。
        </p>
      </section>

      <section className="mb-6">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h2 className="flex items-center gap-1.5 text-[13px] font-medium">
            <Cable size={14} strokeWidth={1.8} className="text-text-tertiary" />
            设备别名
          </h2>
          <AliasForm devices={overview.devices} />
        </div>
        <p className="mb-2 text-[10.5px] leading-4 text-text-tertiary">
          告警里的主机名按「别名 → 设备名 → IP」的顺序匹配，大小写不敏感。匹配不到的行会进批次
          issues，不会静默丢弃。
        </p>

        {overview.aliases.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border-strong bg-surface px-6 py-8 text-center">
            <Cable size={20} strokeWidth={1.5} className="mx-auto text-text-tertiary" />
            <p className="mt-2 text-[13px] font-medium">还没有别名</p>
            <p className="mx-auto mt-1 max-w-[440px] text-[11.5px] leading-5 text-text-tertiary">
              Prometheus 的 <code className="font-mono">instance</code> 带着端口、Zabbix 的 host
              常是小写短名，和 CMDB 里的设备名对不上时，在这里加一条映射即可。
            </p>
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl border border-border bg-surface shadow-card">
            <table className="w-full text-[11.5px]">
              <thead className="bg-surface-muted text-[10px] tracking-wide text-text-tertiary uppercase">
                <tr>
                  <th className="px-3 py-1.5 text-left font-medium">别名</th>
                  <th className="px-3 py-1.5 text-left font-medium">设备</th>
                  <th className="px-3 py-1.5 text-left font-medium">来源</th>
                  <th className="px-3 py-1.5 text-right font-medium">添加时间</th>
                </tr>
              </thead>
              <tbody>
                {overview.aliases.map((row) => (
                  <tr key={row.id} className="border-t border-border">
                    <td className="px-3 py-1.5 font-mono text-[11px]">{row.alias}</td>
                    <td className="px-3 py-1.5">{row.deviceName}</td>
                    <td className="px-3 py-1.5 font-mono text-[10px] text-text-tertiary">
                      {row.source}
                    </td>
                    <td
                      className="px-3 py-1.5 text-right font-mono text-[10px] text-text-tertiary"
                      title={absTime(row.createdAt)}
                    >
                      {relTime(row.createdAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-2 flex items-center gap-1.5 text-[13px] font-medium">
          <Activity size={14} strokeWidth={1.8} className="text-text-tertiary" />
          导入批次
        </h2>
        {overview.batches.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border-strong bg-surface px-6 py-8 text-center text-[12px] text-text-tertiary">
            还没有导入记录。按上面的 curl 推一条，或有数据源开始上报后，这里会出现批次。
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl border border-border bg-surface shadow-card">
            <table className="w-full text-[11.5px]">
              <thead className="bg-surface-muted text-[10px] tracking-wide text-text-tertiary uppercase">
                <tr>
                  <th className="px-3 py-1.5 text-left font-medium">时间</th>
                  <th className="px-3 py-1.5 text-left font-medium">来源 / 类型</th>
                  <th className="px-3 py-1.5 text-left font-medium">进度</th>
                  <th className="px-3 py-1.5 text-right font-medium">入库</th>
                  <th className="px-3 py-1.5 text-right font-medium">去重</th>
                  <th className="px-3 py-1.5 text-right font-medium">失败</th>
                  <th className="px-3 py-1.5 text-right font-medium">耗时</th>
                  <th className="px-3 py-1.5 text-right font-medium">状态</th>
                </tr>
              </thead>
              <tbody>
                {overview.batches.map((batch) => {
                  const status = STATUS_STYLE[batch.status] ?? STATUS_STYLE.QUEUED!;
                  const Icon = status.icon;
                  return (
                    <tr key={batch.id} className="border-t border-border">
                      <td
                        className="px-3 py-1.5 font-mono text-[10px] text-text-tertiary"
                        title={absTime(batch.createdAt)}
                      >
                        {relTime(batch.createdAt)}
                      </td>
                      <td className="px-3 py-1.5">
                        <span className="text-text">{batch.source}</span>
                        <span className="ml-1 font-mono text-[9.5px] text-text-tertiary">
                          {batch.kind}
                        </span>
                      </td>
                      <td className="px-3 py-1.5">
                        <div className="flex items-center gap-1.5">
                          <span className="h-1 w-16 overflow-hidden rounded-full bg-surface-muted">
                            <span
                              className="block h-full rounded-full bg-primary"
                              style={{ width: `${Math.max(2, batch.progress)}%` }}
                            />
                          </span>
                          <span className="font-mono text-[10px] text-text-tertiary">
                            {batch.processed}/{batch.total}
                          </span>
                        </div>
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono text-[10.5px]">
                        {batch.accepted}
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono text-[10.5px] text-text-tertiary">
                        {batch.deduped}
                      </td>
                      <td
                        className={cn(
                          'px-3 py-1.5 text-right font-mono text-[10.5px]',
                          batch.failed > 0 ? 'text-danger' : 'text-text-tertiary',
                        )}
                      >
                        {batch.failed}
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono text-[10px] text-text-tertiary">
                        {batch.durationMs === null ? '—' : `${batch.durationMs} ms`}
                      </td>
                      <td className="px-3 py-1.5 text-right">
                        <span
                          className={cn(
                            'inline-flex items-center gap-0.5 rounded-[3px] px-1 py-px text-[10px]',
                            status.className,
                          )}
                          title={batch.error ?? undefined}
                        >
                          <Icon size={9} strokeWidth={2.2} />
                          {status.label}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
