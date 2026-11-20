import Link from 'next/link';
import { Check, KeyRound, X } from 'lucide-react';
import { Card, CardTitle } from '@/components/ui/card';
import { ScenarioInject } from '@/components/domain/scenario-inject';
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

export const dynamic = 'force-dynamic';

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
        <p>NetScope v0.1.0 · MVP-0 · 单人 + Agent 协作基线 · 阶段 T09（评测与发布）</p>
        <p className="mt-1">
          接口清单见 <code className="font-mono">docs/API.md</code>，已实现范围与已知偏差见{' '}
          <code className="font-mono">docs/STATE.md</code>，评分与失败场景见{' '}
          <code className="font-mono">README.md</code> 评测段。
        </p>
      </div>
    </div>
  );
}
