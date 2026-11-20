import Link from 'next/link';
import { Check, KeyRound, X } from 'lucide-react';
import { Card, CardTitle } from '@/components/ui/card';
import { RetentionPanel } from '@/components/domain/retention-panel';
import { ScenarioInject } from '@/components/domain/scenario-inject';
import { DataBaselineCard, EvalBaselineCard } from '@/components/domain/system-status-cards';
import { absTime } from '@/lib/utils/time';
import { getIncidentStats } from '@/modules/incidents/service';
import {
  auditActionLabel,
  getAuditPanel,
  getModelConfig,
  getScenarios,
  getThresholds,
  getTokenUsage,
} from '@/modules/system/settings';
import { getRetentionPolicy } from '@/modules/system/retention';

export const dynamic = 'force-dynamic';

/** 交付卡片（评审 5.1：从概览页搬到设置页）—— 只在验收时需要，值班时是噪音 */
const DELIVERY = [
  ['T01', '工程基座与门禁', '已完成'],
  ['T02', '数据模型与种子', '已完成'],
  ['T03', '告警接入 + 模拟器', '已完成'],
  ['T04', '归一化 + 抑制 + 生命周期', '已完成'],
  ['T05', '关联聚合', '已完成'],
  ['T06', '事件详情（只读拓扑）', '已完成'],
  ['T07', '根因研判', '已完成'],
  ['T08', '人工确认 + 简版报告', '已完成'],
  ['T09', '评测与发布', '已完成'],
  ['T10', '真实数据源接入', '已完成'],
  ['T11', '批处理导入与批次状态', '已完成'],
  ['T12', '指标快照与时序证据', '已完成'],
  ['T13', 'RBAC / 多租户 / 数据保留', '已完成'],
  ['T14', '运行指标（MTTR / 接受率 / 误抑制）', '已完成'],
  ['T15', '第 4 阶段验收脚本', '已完成'],
] as const;

/**
 * 设置（文档 11.1 `/settings`）。
 *
 * 三块内容，全部只读，只有剧本注入会写库：
 * 1. 模型配置 —— 把 env 摊开，免得每次验证"到底走没走模型"都要去翻 .env；
 * 2. 聚合阈值 —— 直接读 constants.ts，于是页面和代码不可能对不上；
 * 3. 剧本注入 —— 和 `npm run sim` 同一个接口，演示时不用切终端。
 *
 * 做成只读是刻意的：MVP-0 没有配置表，页面上放开关就会出现"页面显示 0.55、
 * 代码里 0.60"的双份事实。要改就改 .env 或 constants.ts，然后重启。
 */
export default async function SettingsPage() {
  const model = getModelConfig();
  const thresholds = getThresholds();
  const scenarios = getScenarios();
  const retention = getRetentionPolicy();
  const [usage, incidentStats, audit] = await Promise.all([
    getTokenUsage(),
    getIncidentStats(),
    getAuditPanel(),
  ]);

  const envRows: { label: string; value: string; mono?: boolean; ok?: boolean }[] = [
    { label: 'Provider', value: model.provider, mono: true },
    { label: '快模型', value: model.modelFast, mono: true },
    { label: '推理模型', value: model.modelReason, mono: true },
    { label: 'API Key', value: model.keyMasked ?? '未配置', ok: model.keyMasked !== null },
    { label: 'LLM_MOCK', value: model.mock ? 'true' : 'false', mono: true },
    { label: '日志级别', value: model.logLevel, mono: true },
    { label: '剧本默认种子', value: model.simSeed, mono: true },
  ];

  return (
    <div className="mx-auto max-w-[1180px]">
      <header className="mb-4">
        <h1 className="text-[22px] leading-7 font-semibold tracking-tight">设置</h1>
        <p className="mt-0.5 text-[12px] text-text-secondary">
          运行参数只读展示 · 模型配置来自 <code className="font-mono">.env</code>，聚合阈值来自{' '}
          <code className="font-mono">constants.ts</code> · 改完需重启进程
        </p>
      </header>

      <Card>
        <CardTitle hint={`LLM 运行模式 · ${model.mode}`}>模型配置</CardTitle>

        <div className="flex flex-wrap items-center gap-2">
          <span
            className={
              model.mode === 'live'
                ? 'rounded-[4px] bg-ok-soft px-2 py-0.5 text-[11px] text-ok'
                : model.mode === 'mock'
                  ? 'rounded-[4px] bg-surface-muted px-2 py-0.5 text-[11px] text-text-secondary'
                  : 'rounded-[4px] bg-warn-soft px-2 py-0.5 text-[11px] text-warn'
            }
          >
            {model.modeLabel}
          </span>
          <span className="flex items-center gap-1 text-[12px] text-text-tertiary">
            {model.keyMasked ? (
              <Check size={12} strokeWidth={2.2} className="text-ok" />
            ) : (
              <X size={12} strokeWidth={2.2} className="text-warn" />
            )}
            <KeyRound size={11} strokeWidth={1.8} />
            {model.keyMasked ?? '未配置'}
          </span>
        </div>
        <p className="mt-2 text-[12px] leading-relaxed text-text-secondary">{model.modeNote}</p>

        <dl className="mt-3 grid grid-cols-1 gap-x-8 gap-y-1.5 sm:grid-cols-2">
          {envRows.map((row) => (
            <div key={row.label} className="flex items-baseline gap-3 py-0.5">
              <dt className="w-[84px] shrink-0 text-[12px] text-text-tertiary">{row.label}</dt>
              <dd
                className={`min-w-0 flex-1 truncate text-[12px] ${
                  row.mono ? 'font-mono' : ''
                } ${row.ok === false ? 'text-warn' : 'text-text-secondary'}`}
                title={row.value}
              >
                {row.value}
              </dd>
            </div>
          ))}
        </dl>

        <div className="mt-4 rounded-[8px] bg-surface-muted px-3 py-2.5">
          <p className="flex flex-wrap items-baseline gap-2 text-[12px] text-text-secondary">
            累计消耗
            <span className="tabular font-mono text-[16px] leading-6 text-text">
              {usage.tokens.toLocaleString('en-US')}
            </span>
            tokens · {usage.calls} 次研判
          </p>
          {usage.rows.length > 0 ? (
            <table className="mt-2 w-full text-[11.5px]">
              <thead>
                <tr className="text-left text-text-tertiary">
                  <th className="pb-1 font-normal">模型</th>
                  <th className="pb-1 font-normal">来源</th>
                  <th className="pb-1 text-right font-normal">次数</th>
                  <th className="pb-1 text-right font-normal">tokens</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {usage.rows.map((row) => (
                  <tr key={`${row.model}-${row.source}`} className="text-text-secondary">
                    <td className="py-0.5">{row.model}</td>
                    <td className="py-0.5">{row.source}</td>
                    <td className="tabular py-0.5 text-right">{row.calls}</td>
                    <td className="tabular py-0.5 text-right">
                      {row.tokens.toLocaleString('en-US')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="mt-1 text-[11.5px] text-text-tertiary">
              还没有研判记录。跑一次 <code className="font-mono">npm run rca:analyze</code> 就有了。
            </p>
          )}
          {usage.calls > 0 && usage.tokens === 0 ? (
            <p className="mt-1.5 text-[11.5px] text-text-tertiary">
              全部由规则降级产出，token 记 0 —— 不是没记账，是真的没调模型。
            </p>
          ) : null}
        </div>
      </Card>

      <Card className="mt-4">
        <CardTitle hint="src/modules/correlation/constants.ts">聚合阈值</CardTitle>
        <div className="grid gap-4 sm:grid-cols-2">
          {thresholds.map((group) => (
            <div key={group.title}>
              <p className="mb-1.5 flex items-baseline gap-2">
                <span className="text-[13px] font-medium text-text">{group.title}</span>
                <span className="font-mono text-[10.5px] text-text-tertiary">{group.hint}</span>
              </p>
              <dl className="space-y-1">
                {group.rows.map((row) => (
                  <div key={row.label} className="flex items-baseline justify-between gap-2">
                    <dt className="text-[12px] text-text-secondary">
                      {row.label}
                      {row.note ? (
                        <span className="ml-1 text-[11px] text-text-tertiary">{row.note}</span>
                      ) : null}
                    </dt>
                    <dd className="tabular shrink-0 font-mono text-[12px] text-text">
                      {row.value}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </div>
        <p className="mt-3 text-[11.5px] leading-relaxed text-text-tertiary">
          这些数字是调参的唯一入口：改这里，跑{' '}
          <code className="font-mono">npm run eval -- --set=dev</code>{' '}
          看分数有没有变好，再决定要不要动。test 集只在定稿时跑一次 —— 对着 test 调阈值，
          报出来的分数就没有意义了。
        </p>
      </Card>

      <Card className="mt-4">
        <CardTitle hint={`共 ${scenarios.length} 套 · 走 /api/v1/ingest/simulate`}>
          剧本注入
        </CardTitle>
        <ScenarioInject items={scenarios} activeIncidents={incidentStats.open} />
        <p className="mt-3 text-[11.5px] leading-relaxed text-text-tertiary">
          和命令行的 <code className="font-mono">npm run sim -- --scenario=…</code>{' '}
          是同一个接口、同一份 fixture。注入后告警会进入正常的解析 → 归一 → 聚合流程，
          不存在"演示专用通道"。想核对某一屏，可对照{' '}
          <Link href="/overview" className="text-primary hover:underline">
            概览
          </Link>{' '}
          的数据基线变化。
        </p>
      </Card>

      <Card className="mt-4">
        <CardTitle
          hint={`近 24 小时 ${audit.summary.last24h} 次 · 失败 ${audit.summary.failures} 次`}
        >
          操作审计
        </CardTitle>

        {audit.summary.byAction.length > 0 ? (
          <div className="mb-2 flex flex-wrap gap-1">
            {audit.summary.byAction.map((item) => (
              <span
                key={item.action}
                className="rounded-[3px] bg-surface-muted px-1.5 py-0.5 text-[10.5px] text-text-secondary"
              >
                {auditActionLabel(item.action)}
                <span className="ml-1 font-mono text-[9.5px] text-text-tertiary">{item.count}</span>
              </span>
            ))}
          </div>
        ) : null}

        {audit.rows.length > 0 ? (
          <table className="w-full text-[11.5px]">
            <thead>
              <tr className="text-left text-text-tertiary">
                <th className="pb-1 font-normal">时间</th>
                <th className="pb-1 font-normal">动作</th>
                <th className="pb-1 font-normal">对象</th>
                <th className="pb-1 text-right font-normal">结果</th>
              </tr>
            </thead>
            <tbody>
              {audit.rows.map((row) => (
                <tr key={row.id} className="border-t border-border/70 align-top">
                  <td className="tabular py-1 font-mono text-[10.5px] text-text-tertiary">
                    {absTime(row.at)}
                  </td>
                  <td className="py-1 text-text-secondary">
                    {row.actionLabel}
                    <span className="ml-1 font-mono text-[10px] text-text-tertiary">
                      {row.actor}
                    </span>
                  </td>
                  <td className="py-1 text-text-secondary">
                    <span className="font-mono text-[10.5px]">{row.target ?? '—'}</span>
                    {row.summary ? (
                      <span className="ml-1.5 text-[10.5px] text-text-tertiary">{row.summary}</span>
                    ) : null}
                  </td>
                  <td
                    className={`py-1 text-right text-[10.5px] ${row.ok ? 'text-ok' : 'text-danger'}`}
                  >
                    {row.ok ? '成功' : '失败'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-[11.5px] text-text-tertiary">
            还没有审计记录。研判、裁决、结案、导入任一动作都会在这里留痕。
          </p>
        )}

        <p className="mt-3 text-[11.5px] leading-relaxed text-text-tertiary">
          审计记的是「谁在什么时候对哪个资源做了什么、成没成」，落库不落日志文件 ——
          日志会被滚掉，事后追责只能靠它。完整记录走{' '}
          <code className="font-mono">GET /api/v1/audit</code>（production 下需要 API Key）。
        </p>
      </Card>

      <div className="mt-4 rounded-xl border border-border bg-surface px-5 py-4 text-[11.5px] leading-relaxed text-text-tertiary shadow-card">
        <p>
          NetScope v0.1.0 · MVP-0 · 单人 + Agent 协作基线 · 阶段「第 4 阶段：真实数据接入和规模化」
        </p>
        <p className="mt-1">
          接口清单见 <code className="font-mono">docs/API.md</code>，已实现范围与已知偏差见{' '}
          <code className="font-mono">docs/STATE.md</code>，评分与失败场景见{' '}
          <code className="font-mono">README.md</code> 评测段。
        </p>
      </div>

      {/* —— 安全与保留（第 4 阶段：RBAC、租户、数据保留） —— */}
      <div className="mt-6 mb-2 flex items-baseline gap-2">
        <h2 className="text-[15px] font-medium tracking-tight">安全与保留</h2>
        <span className="text-[11.5px] text-text-tertiary">
          角色划分来自 <code className="font-mono">API_KEYS</code>，保留天数来自环境变量
        </span>
      </div>

      <div className="space-y-4">
        <Card>
          <CardTitle hint="production 生效，local 一律放行">访问控制</CardTitle>
          <table className="w-full text-[11.5px]">
            <thead className="text-[10px] tracking-wide text-text-tertiary uppercase">
              <tr>
                <th className="py-1 text-left font-medium">角色</th>
                <th className="py-1 text-left font-medium">能力</th>
              </tr>
            </thead>
            <tbody className="text-text-secondary">
              <tr className="border-t border-border">
                <td className="py-1.5 font-mono text-[11px]">VIEWER</td>
                <td className="py-1.5">读接口（页面、事件、案例）</td>
              </tr>
              <tr className="border-t border-border">
                <td className="py-1.5 font-mono text-[11px]">RESPONDER</td>
                <td className="py-1.5">所有写操作：导入、研判、裁决、接手、结案、拆分、验证勾选</td>
              </tr>
              <tr className="border-t border-border">
                <td className="py-1.5 font-mono text-[11px]">ADMIN</td>
                <td className="py-1.5">审计查询、数据源别名、保留策略清理</td>
              </tr>
            </tbody>
          </table>
          <p className="mt-2.5 text-[11px] leading-5 text-text-tertiary">
            多 Key 配置：
            <code className="font-mono">
              API_KEYS=`[{`{`}
              &quot;key&quot;:&quot;…&quot;,&quot;role&quot;:&quot;RESPONDER&quot;,&quot;tenant&quot;:&quot;default&quot;
              {`}`}]`
            </code>
            ；只配 <code className="font-mono">API_KEY</code> 时视为 ADMIN + default 租户。租户由
            Key 决定，不接受请求头自称。
          </p>
        </Card>

        <Card>
          <CardTitle hint="dry-run 默认">数据保留</CardTitle>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-[11.5px] sm:grid-cols-4">
            <div>
              <dt className="text-[10px] text-text-tertiary">指标采样</dt>
              <dd className="font-mono">{retention.metricDays} 天</dd>
            </div>
            <div>
              <dt className="text-[10px] text-text-tertiary">审计日志</dt>
              <dd className="font-mono">{retention.auditDays} 天</dd>
            </div>
            <div>
              <dt className="text-[10px] text-text-tertiary">导入批次</dt>
              <dd className="font-mono">{retention.batchDays} 天</dd>
            </div>
            <div>
              <dt className="text-[10px] text-text-tertiary">已结案事件</dt>
              <dd className="font-mono">
                {retention.closedIncidentDays === 0
                  ? '不清理'
                  : `${retention.closedIncidentDays} 天`}
              </dd>
            </div>
          </dl>
          <p className="mt-2 text-[11px] leading-5 text-text-tertiary">
            事件默认不清理：MTTR、接受率、误抑制率都从事件算，删掉指标就断档。要控体量应该归档到冷存储。
          </p>
          <RetentionPanel policy={retention} />
        </Card>
      </div>

      {/* —— 系统状态（原概览页的验收材料，评审 5.1 搬迁至此） —— */}
      <div className="mt-6 mb-2 flex items-baseline gap-2">
        <h2 className="text-[15px] font-medium tracking-tight">系统状态</h2>
        <span className="text-[11.5px] text-text-tertiary">
          数据基线 · 评测基线 · 交付进度；值班时不看这些，验收时在这里
        </span>
      </div>

      <div className="space-y-4">
        <DataBaselineCard />
        <EvalBaselineCard />

        <Card>
          <CardTitle
            hint={`${DELIVERY.filter(([, , state]) => state === '已完成').length}/${DELIVERY.length} 已完成`}
          >
            交付进度
          </CardTitle>
          <ul className="grid grid-cols-1 gap-x-8 gap-y-1 sm:grid-cols-2">
            {DELIVERY.map(([id, name, state]) => (
              <li key={id} className="flex items-baseline gap-2 text-[12px]">
                <span className="w-8 shrink-0 font-mono text-[10.5px] text-text-tertiary">
                  {id}
                </span>
                <span className="min-w-0 flex-1 truncate text-text-secondary">{name}</span>
                <span className="shrink-0 text-[10.5px] text-ok">{state}</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}
