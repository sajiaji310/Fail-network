import { format } from 'date-fns';
import { Card, CardTitle } from '@/components/ui/card';
import { StatusPill, type Tone } from '@/components/ui/status-pill';
import { RefreshButton } from '@/components/domain/refresh-button';
import { getSystemStatus } from '@/modules/system/service';

export const dynamic = 'force-dynamic';

const UPCOMING = [
  ['T02', '数据模型与种子'],
  ['T03', '告警接入 + 模拟器'],
  ['T04', '归一化 + 抑制 + 生命周期'],
  ['T05', '关联聚合'],
  ['T06', '事件详情（只读拓扑）'],
  ['T07', '根因研判'],
  ['T08', '人工确认 + 简版报告'],
  ['T09', '评测与发布'],
] as const;

export default async function OverviewPage() {
  const s = await getSystemStatus();

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

      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        <Card>
          <CardTitle hint="复制到终端逐条执行">人工验收命令</CardTitle>
          <pre className="overflow-x-auto rounded-[6px] bg-surface-muted p-3 font-mono text-[12px] leading-6 text-text-secondary">
            {`curl -s localhost:3000/api/health | jq .
npm run lint && npm run typecheck
npm run build`}
          </pre>
          <p className="mt-3 text-[12px] text-text-tertiary">
            期望：health 返回 <code className="font-mono">db: &quot;up&quot;</code> 且 HTTP 200；三条命令零报错。
          </p>
        </Card>

        <Card>
          <CardTitle hint="MVP-0 剩余 8 张卡">任务卡进度</CardTitle>
          <ul className="space-y-1.5">
            {UPCOMING.map(([id, title]) => (
              <li key={id} className="flex items-center gap-2.5 text-[13px]">
                <span className="font-mono text-[11px] text-text-tertiary">{id}</span>
                <span className="text-text-secondary">{title}</span>
                <span className="ml-auto rounded-[4px] bg-surface-muted px-1.5 py-px text-[11px] text-text-tertiary">
                  未开始
                </span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}
