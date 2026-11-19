import { format } from 'date-fns';
import Link from 'next/link';
import { Card, CardTitle } from '@/components/ui/card';
import { StatusPill, type Tone } from '@/components/ui/status-pill';
import { RefreshButton } from '@/components/domain/refresh-button';
import { getAlertStats } from '@/modules/alerts/service';
import { getIncidentStats, listIncidents } from '@/modules/incidents/service';
import { getDataSummary, getSystemStatus, SEED_BASELINE } from '@/modules/system/service';
import { EVAL_TARGETS, getEvalSummary } from '@/modules/system/eval-summary';

export const dynamic = 'force-dynamic';

const UPCOMING = [
  ['T02', '数据模型与种子', '已完成'],
  ['T03', '告警接入 + 模拟器', '已完成'],
  ['T04', '归一化 + 抑制 + 生命周期', '已完成'],
  ['T05', '关联聚合', '已完成'],
  ['T06', '事件详情（只读拓扑）', '已完成'],
  ['T07', '根因研判', '已完成'],
  ['T08', '人工确认 + 简版报告', '已完成'],
  ['T09', '评测与发布', '已完成'],
] as const;

const SEVERITY_TONE: Record<string, Tone> = { P0: 'danger', P1: 'danger', P2: 'warn', P3: 'muted' };

export default async function OverviewPage() {
  const [s, data, alerts, incidents, openList, evalTest] = await Promise.all([
    getSystemStatus(),
    getDataSummary(),
    getAlertStats(),
    getIncidentStats(),
    listIncidents({ status: ['OPEN', 'ANALYZING', 'LOCATED', 'MITIGATED'], page: 1, pageSize: 5 }),
    getEvalSummary('test'),
  ]);

  const compression = incidents.open > 0 ? (alerts.active / incidents.open).toFixed(1) : '—';
  const doneCards = UPCOMING.filter(([, , state]) => state === '已完成').length;

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

      <Card className="mt-4">
        <CardTitle hint="T05 关联聚合 · B1–B9">事件</CardTitle>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            { label: '活跃事件', value: incidents.open },
            { label: '24h 新增', value: incidents.last24h },
            { label: '累计事件', value: incidents.total },
            { label: '告警/事件', value: compression },
          ].map((item) => (
            <div key={item.label} className="rounded-[8px] bg-surface-muted px-3 py-2">
              <p className="text-[12px] text-text-secondary">{item.label}</p>
              <p className="mt-0.5 flex items-baseline gap-1">
                <span className="tabular font-mono text-[18px] leading-6">{item.value}</span>
              </p>
            </div>
          ))}
        </div>

        {openList.items.length > 0 ? (
          <ul className="mt-3 divide-y divide-border rounded-[8px] border border-border">
            {openList.items.map((i) => (
              <li key={i.id}>
                <Link
                  href={`/incidents/${i.id}`}
                  className="flex items-center gap-2.5 px-3 py-2 text-[13px] transition-colors hover:bg-surface-muted"
                >
                  <span className="font-mono text-[11px] text-text-tertiary">{i.code}</span>
                  <StatusPill tone={SEVERITY_TONE[i.severity] ?? 'muted'}>{i.severity}</StatusPill>
                  <span className="truncate text-text-secondary">{i.title}</span>
                  <span className="ml-auto shrink-0 font-mono text-[11px] text-text-tertiary">
                    {i.alertCount} 条 / {i.deviceCount} 台 · {format(i.lastSeen, 'HH:mm')}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-[12px] text-text-tertiary">
            暂无活跃事件。注入剧本（或 <code className="font-mono">npm run corr:run</code>
            ）后，5 分钟内 ≥ 3 条关联告警会聚成一个事件。
          </p>
        )}
      </Card>

      <Card className="mt-4">
        <CardTitle
          hint={evalTest ? `留出集 ${evalTest.total} 个场景 · 调参全程只碰 dev 集` : '尚未跑分'}
        >
          评测基线
        </CardTitle>

        {evalTest ? (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                {
                  label: 'Top1 命中率',
                  value: `${(evalTest.top1Rate * 100).toFixed(1)}%`,
                  target: `≥ ${EVAL_TARGETS.top1 * 100}%`,
                  ok: evalTest.top1Rate >= EVAL_TARGETS.top1,
                },
                {
                  label: 'Top3 命中率',
                  value: `${(evalTest.top3Rate * 100).toFixed(1)}%`,
                  target: `≥ ${EVAL_TARGETS.top3 * 100}%`,
                  ok: evalTest.top3Rate >= EVAL_TARGETS.top3,
                },
                {
                  label: '告警压缩比',
                  value: `${evalTest.compression.toFixed(1)}:1`,
                  target: `≥ ${EVAL_TARGETS.compression}:1`,
                  ok: evalTest.compression >= EVAL_TARGETS.compression,
                },
                {
                  label: '全通过场景',
                  value: `${evalTest.passed}/${evalTest.total}`,
                  target: '全部',
                  ok: evalTest.passed === evalTest.total,
                },
              ].map((item) => (
                <div key={item.label} className="rounded-[8px] bg-surface-muted px-3 py-2">
                  <p className="flex items-baseline gap-1.5 text-[12px] text-text-secondary">
                    {item.label}
                    <span className={`text-[10px] ${item.ok ? 'text-ok' : 'text-danger'}`}>
                      {item.ok ? '达标' : '未达标'}
                    </span>
                  </p>
                  <p className="mt-0.5 flex items-baseline gap-1">
                    <span
                      className={`tabular font-mono text-[18px] leading-6 ${
                        item.ok ? '' : 'text-danger'
                      }`}
                    >
                      {item.value}
                    </span>
                    <span className="font-mono text-[11px] text-text-tertiary">
                      / {item.target}
                    </span>
                  </p>
                </div>
              ))}
            </div>

            <div className="mt-3 space-y-1 text-[12px]">
              <p className="text-text-secondary">
                证据相关率 {(evalTest.evidenceRate * 100).toFixed(0)}% · 精确率/召回率{' '}
                {(evalTest.precision * 100).toFixed(0)}% / {(evalTest.recall * 100).toFixed(0)}% ·
                误抑制 {evalTest.suppressionErrors} 条 · {evalTest.avgDurationMs} ms/场景
              </p>
              {evalTest.failed.length > 0 ? (
                <p className="text-text-secondary">
                  <span className="text-danger">未通过</span>：
                  {evalTest.failed.map((f) => `${f.id}「${f.title}」`).join(' · ')}
                </p>
              ) : (
                <p className="text-ok">全部场景通过</p>
              )}
              <p className="text-[11px] text-text-tertiary">
                数据源 <code className="font-mono">evals/results/test.json</code> · 跑于{' '}
                {format(new Date(evalTest.startedAt), 'MM-dd HH:mm')} · 推理模式 {evalTest.mode} ·
                压缩比未达标属已知欠账，README 已照实写明
              </p>
            </div>
          </>
        ) : (
          <p className="text-[12px] text-text-tertiary">
            还没有评测产物。执行 <code className="font-mono">npm run eval -- --set=test</code>{' '}
            后刷新本页；产物在 <code className="font-mono">evals/results/test.md</code>。
          </p>
        )}
      </Card>

      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        <Card>
          <CardTitle hint="复制到终端逐条执行">人工验收命令</CardTitle>
          <pre className="overflow-x-auto rounded-[6px] bg-surface-muted p-3 font-mono text-[12px] leading-6 text-text-secondary">
            {`npm run eval -- --set=test      # 留出集跑分，出 Markdown 表
npm run eval -- --set=dev       # 开发集对照
npx playwright test             # 两条主路径 E2E`}
          </pre>
          <p className="mt-3 text-[12px] text-text-tertiary">
            期望：Top1 85.7% / Top3 85.7% / 压缩比 6.0:1（
            <span className="text-danger">未达标</span>
            ，目标 8:1）/ 全通过 7/8；E2E <span className="text-ok">2 passed</span>。
          </p>
        </Card>

        <Card>
          <CardTitle hint={`已完成 ${doneCards} / ${UPCOMING.length} · 仅记录进度，不可点击`}>
            任务卡进度
          </CardTitle>
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
          <p className="mt-3 text-[11px] text-text-tertiary">
            验收入口在左侧导航（概览 / 告警流 / 事件 / 拓扑 / 案例库），这张表只是进度记录。
          </p>
        </Card>
      </div>
    </div>
  );
}
