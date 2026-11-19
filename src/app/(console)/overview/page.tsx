import { format } from 'date-fns';
import { Card, CardTitle } from '@/components/ui/card';
import { StatusPill, type Tone } from '@/components/ui/status-pill';
import { RefreshButton } from '@/components/domain/refresh-button';
import { getAlertStats } from '@/modules/alerts/service';
import { getDataSummary, getSystemStatus, SEED_BASELINE } from '@/modules/system/service';

export const dynamic = 'force-dynamic';

const UPCOMING = [
  ['T02', '数据模型与种子', '已完成'],
  ['T03', '告警接入 + 模拟器', '已完成'],
  ['T04', '归一化 + 抑制 + 生命周期', '已完成'],
  ['T05', '关联聚合', '未开始'],
  ['T06', '事件详情（只读拓扑）', '未开始'],
  ['T07', '根因研判', '未开始'],
  ['T08', '人工确认 + 简版报告', '未开始'],
  ['T09', '评测与发布', '未开始'],
] as const;

export default async function OverviewPage() {
  const [s, data, alerts] = await Promise.all([
    getSystemStatus(),
    getDataSummary(),
    getAlertStats(),
  ]);

  const checks: { label: string; value: string; tone: Tone; text: string }[] = [
    {
      label: '应用基座',
      value: 'Next.js 15 · App Router',
      tone: 'ok',
      text: '运行中',
    },
    {
      label: '数据库',
      value: s.dbVersion ?? '—',
      tone: s.db === 'up' ? 'ok' : 'danger',
      text: s.db === 'up' ? '已连接' : '不可用',
    },
    {
      label: 'AI 引擎',
      value: s.llm === 'fallback' ? '未配置 key · 规则降级' : s.llmModel,
      tone: s.llm === 'fallback' ? 'warn' : 'info',
      text: s.llm === 'live' ? 'LLM 在线' : s.llm === 'mock' ? 'Mock 模式' : '规则降级',
    },
    {
      label: '运行时',
      value: `Node ${s.node} · ${format(new Date(s.checkedAt), 'HH:mm:ss')}`,
      tone: 'muted',
      text: '本机',
    },
  ];

  return (
    <div className="mx-auto max-w-[1100px]">
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[20px] font-medium tracking-tight">概览</h1>
          <p className="mt-0.5 text-[13px] text-text-secondary">
            环境自检页 · T01 工程基座验收用，T05 起由指标卡替换
          </p>
        </div>
        <RefreshButton />
      </div>

      {s.db === 'down' ? (
        <div className="mb-4 rounded-[8px] border border-border bg-[#FEF3F2] px-4 py-3 text-[13px] text-danger">
          <p className="font-medium">数据库连接失败</p>
          <p className="mt-0.5 font-mono text-[12px] break-all opacity-80">{s.dbError}</p>
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {checks.map((c) => (
          <Card key={c.label} className="p-4">
            <p className="text-[12px] text-text-secondary">{c.label}</p>
            <p className="mt-2 truncate font-mono text-[13px]" title={c.value}>
              {c.value}
            </p>
            <div className="mt-3">
              <StatusPill tone={c.tone}>{c.text}</StatusPill>
            </div>
          </Card>
        ))}
      </div>

      <Card className="mt-4">
        <CardTitle
          hint={`基线 ${SEED_BASELINE.devices} / ${SEED_BASELINE.links} / ${SEED_BASELINE.cases}`}
        >
          数据基线
        </CardTitle>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            { label: '设备', value: data.devices, base: SEED_BASELINE.devices },
            { label: '链路', value: data.links, base: SEED_BASELINE.links },
            { label: '历史案例', value: data.cases, base: SEED_BASELINE.cases },
            { label: '告警', value: data.alerts, base: null },
          ].map((item) => (
            <div key={item.label} className="rounded-[8px] bg-surface-muted px-3 py-2">
              <p className="text-[12px] text-text-secondary">{item.label}</p>
              <p className="mt-0.5 flex items-baseline gap-1">
                <span className="tabular font-mono text-[18px] leading-6">{item.value}</span>
                {item.base !== null ? (
                  <span className="font-mono text-[11px] text-text-tertiary">/ {item.base}</span>
                ) : null}
              </p>
            </div>
          ))}
        </div>
        <div className="mt-3 flex items-center gap-2 text-[12px] text-text-secondary">
          <StatusPill tone={data.seedReady ? 'ok' : 'warn'}>
            {data.seedReady ? '种子数据就位' : '待执行 npm run db:seed'}
          </StatusPill>
          <span className="text-text-tertiary">
            {data.alerts === 0
              ? '告警为 0 属正常：T03 起才有接入数据'
              : '告警行数按「发生周期」计，同周期重复上报已折叠进 count'}
          </span>
        </div>
      </Card>

      <Card className="mt-4">
        <CardTitle hint="T04 归一化 + 父子抑制 + 生命周期">告警状态</CardTitle>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            { label: 'ACTIVE 有效', value: alerts.active, tone: 'ok' as Tone },
            { label: 'SUPPRESSED 被抑制', value: alerts.suppressed, tone: 'warn' as Tone },
            { label: 'RESOLVED 已恢复', value: alerts.resolved, tone: 'muted' as Tone },
            { label: '折叠次数', value: alerts.collapsed, tone: 'info' as Tone },
          ].map((item) => (
            <div key={item.label} className="rounded-[8px] bg-surface-muted px-3 py-2">
              <p className="text-[12px] text-text-secondary">{item.label}</p>
              <p className="mt-0.5 flex items-baseline gap-1">
                <span className="tabular font-mono text-[18px] leading-6">{item.value}</span>
                {alerts.total > 0 ? (
                  <span className="font-mono text-[11px] text-text-tertiary">/ {alerts.total}</span>
                ) : null}
              </p>
            </div>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-[12px]">
          <StatusPill tone={alerts.suppressed > 0 ? 'warn' : 'muted'}>
            {alerts.suppressed > 0 ? '抑制生效' : '无抑制'}
          </StatusPill>
          {alerts.suppressedByType.length > 0 ? (
            <span className="text-text-secondary">
              抑制明细：
              {alerts.suppressedByType.map((s) => `${s.type} ${s.count}`).join(' · ')}
            </span>
          ) : (
            <span className="text-text-tertiary">
              注入 core-switch-board-failure 后，核心设备上 13 条子告警应被压制，根因告警保持 ACTIVE
            </span>
          )}
        </div>
      </Card>

      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        <Card>
          <CardTitle hint="复制到终端逐条执行">人工验收命令</CardTitle>
          <pre className="overflow-x-auto rounded-[6px] bg-surface-muted p-3 font-mono text-[12px] leading-6 text-text-secondary">
            {`curl -s "localhost:3000/api/v1/alerts?status=SUPPRESSED" | jq .
npm run alerts:stats
npm run sim -- --scenario=core-switch-board-failure`}
          </pre>
          <p className="mt-3 text-[12px] text-text-tertiary">
            期望：SUPPRESSED 列表非空且 <code className="font-mono">suppressedByAlertId</code>{' '}
            指向父告警；根因 <code className="font-mono">LINECARD_FAILURE</code> 仍在 ACTIVE。
          </p>
        </Card>

        <Card>
          <CardTitle hint="已完成 3 / 8">任务卡进度</CardTitle>
          <ul className="space-y-1.5">
            {UPCOMING.map(([id, title, state]) => (
              <li key={id} className="flex items-center gap-2.5 text-[13px]">
                <span className="font-mono text-[11px] text-text-tertiary">{id}</span>
                <span className="text-text-secondary">{title}</span>
                <span
                  className={`ml-auto rounded-[4px] px-1.5 py-px text-[11px] ${
                    state === '已完成'
                      ? 'bg-[#ECFDF3] text-ok'
                      : 'bg-surface-muted text-text-tertiary'
                  }`}
                >
                  {state}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}
