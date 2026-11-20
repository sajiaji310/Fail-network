'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { absTime, relTime } from '@/lib/utils/time';
import { deviceLayerLabel } from '@/modules/alerts/labels';
import { SERVICE_TIER_LABEL, type AffectedService } from '@/modules/business/impact';
import { STAGE_LABEL, STAGE_ORDER, type AnalysisProgress } from '@/modules/rca/progress';
import type { AnalysisMeta } from '@/modules/rca/schema';
import type { IncidentChange, IncidentDevice } from '@/modules/incidents/detail';
import type { HypothesisView } from '@/modules/incidents/hypothesis-view';
import { changeKindLabel } from '@/modules/incidents/timeline';
import type { TopologyCoverage } from '@/modules/topology/completeness';
import { EmptyHypotheses, HypothesisCard, VerifyBadge } from './hypothesis-card';

/**
 * 右栏：根因与证据。
 *
 * 研判按钮是这里唯一的写操作：POST → 落库 → router.refresh() 重新取 RSC 数据。
 * 刻意不用客户端状态存结论 —— 页面刷新后必须还能看到上次研判（结论是审计材料，
 * 不是一次性的 toast）。
 */

export type HypothesisPanelProps = {
  incidentId: string;
  hypotheses: readonly HypothesisView[];
  analysis: AnalysisMeta | null;
  summary: string | null;
  impactScope: string | null;
  changes: readonly IncidentChange[];
  devices: readonly IncidentDevice[];
  /** 受影响业务服务（评审第 3 阶段）：设备是"哪里坏了"，服务是"谁受影响" */
  services: readonly AffectedService[];
  topology: TopologyCoverage;
  topologyNote: string | null;
  selectedDeviceId?: string | null;
  onSelectDevice?: (deviceId: string) => void;
};

export function HypothesisPanel({
  incidentId,
  hypotheses,
  analysis,
  summary,
  impactScope,
  changes,
  devices,
  services,
  topology,
  topologyNote,
  selectedDeviceId = null,
  onSelectDevice,
}: HypothesisPanelProps) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [verdictPendingId, setVerdictPendingId] = useState<string | null>(null);
  const [confirmReanalyze, setConfirmReanalyze] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 研判阶段进度（评审第 3 阶段）：POST 未返回时轮询，返回后展示各阶段耗时 */
  const [progress, setProgress] = useState<AnalysisProgress | null>(null);

  async function analyze(force: boolean) {
    setPending(true);
    setError(null);
    setProgress(null);

    // 研判是同步 POST，进度靠轮询同进程的阶段表；POST 一旦返回就停，
    // 不用等最后一个 tick（否则"完成"会延迟 600ms 才显示）
    const timer = setInterval(() => {
      void fetch(`/api/v1/incidents/${encodeURIComponent(incidentId)}/analyze/status`, {
        cache: 'no-store',
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((body: { progress?: AnalysisProgress | null } | null) => {
          if (body?.progress) setProgress(body.progress);
        })
        .catch(() => {
          // 轮询失败不影响研判本身，静默即可
        });
    }, 400);

    try {
      const res = await fetch(
        `/api/v1/incidents/${encodeURIComponent(incidentId)}/analyze${force ? '?force=1' : ''}`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
      );
      const body = (await res.json().catch(() => null)) as {
        error?: { message?: string };
        progress?: AnalysisProgress | null;
      } | null;
      if (!res.ok) {
        throw new Error(body?.error?.message ?? `研判失败（HTTP ${res.status}）`);
      }
      if (body?.progress) setProgress(body.progress);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : '研判失败');
    } finally {
      clearInterval(timer);
      setPending(false);
    }
  }

  const analyzed = analysis !== null;
  const isRule = analysis?.source === 'RULE_FALLBACK';
  const acceptedHypothesis = hypotheses.find((h) => h.verdict === 'ACCEPTED') ?? null;

  /** 采纳/否决：服务端保证"采纳"单选，前端只负责发请求并刷新 */
  async function setVerdict(hypothesisId: string, verdict: 'ACCEPTED' | 'REJECTED' | null) {
    setVerdictPendingId(hypothesisId);
    setError(null);
    try {
      const res = await fetch(
        `/api/v1/incidents/${encodeURIComponent(incidentId)}/hypotheses/${encodeURIComponent(hypothesisId)}`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ verdict }),
        },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        throw new Error(body?.error?.message ?? `裁决失败（HTTP ${res.status}）`);
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : '裁决失败');
    } finally {
      setVerdictPendingId(null);
    }
  }

  return (
    <div className="space-y-4">
      <section>
        <div className="mb-2 flex items-baseline justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <h2 className="text-[13px] font-medium">根因研判</h2>
            {topology.level !== 'FULL' ? (
              <span
                className="rounded-[4px] bg-warn-soft px-1.5 py-px text-[10px] font-medium text-warn ring-1 ring-inset ring-warn/18"
                title="拓扑不完整，以下按候选可能性排序，不作为根因结论"
              >
                候选排序
              </span>
            ) : null}
          </div>
          {hypotheses.length > 0 ? (
            <div className="flex items-center gap-1.5">
              {confirmReanalyze ? (
                <span className="text-[10px] text-warn">会清空已采纳裁决</span>
              ) : null}
              <button
                type="button"
                onClick={() => {
                  // 重研判会整体替换假设集合，已采纳的裁决随之消失 —— 有裁决时必须二次确认
                  if (acceptedHypothesis && !confirmReanalyze) {
                    setConfirmReanalyze(true);
                    return;
                  }
                  setConfirmReanalyze(false);
                  analyze(true);
                }}
                disabled={pending}
                className={cn(
                  'inline-flex items-center gap-1 rounded-[4px] px-1 text-[10px] disabled:opacity-50',
                  confirmReanalyze
                    ? 'text-danger hover:text-danger'
                    : 'text-text-tertiary hover:text-primary',
                )}
              >
                {pending ? <Loader2 size={10} className="animate-spin" /> : null}
                {confirmReanalyze ? '确认重新研判' : '重新研判'}
              </button>
            </div>
          ) : null}
        </div>

        {analyzed ? (
          <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-text-tertiary">
            <span className={isRule ? 'text-warn' : 'text-primary'}>
              {isRule ? '规则引擎' : '模型研判'}
            </span>
            <span aria-hidden>·</span>
            <time
              dateTime={analysis.analyzedAt}
              title={absTime(analysis.analyzedAt)}
              suppressHydrationWarning
            >
              {relTime(analysis.analyzedAt)}
            </time>
            {analysis.trim.length > 0 ? (
              <>
                <span aria-hidden>·</span>
                <span title={`已裁剪：${analysis.trim.join('、')}`}>上下文已裁剪</span>
              </>
            ) : null}
          </div>
        ) : null}

        {progress ? <StageTimeline progress={progress} /> : null}

        {topologyNote ? (
          <p className="mb-2 rounded-[6px] border border-warn/25 bg-warn-soft px-2 py-1.5 text-[10.5px] leading-4 text-warn">
            {topologyNote}
          </p>
        ) : null}

        {summary ? (
          <p className="mb-2 rounded-[6px] bg-primary-soft px-2 py-1.5 text-[11px] leading-4 text-primary">
            {summary}
          </p>
        ) : null}

        {hypotheses.length === 0 ? (
          analyzed ? (
            <EmptyHypotheses
              missingInfo={analysis.missingInfo}
              onAnalyze={() => analyze(true)}
              pending={pending}
            />
          ) : (
            <div className="rounded-[8px] border border-dashed border-border-strong px-3 py-4">
              <p className="text-[12px] font-medium text-text">尚未研判</p>
              <p className="mt-1 text-[11px] leading-4 text-text-tertiary">
                先由规则引擎给出候选，再交模型结构化推理，最后逐条过证据校验。没有 API Key
                也能跑完整链路。
              </p>
              <button
                type="button"
                onClick={() => analyze(false)}
                disabled={pending}
                className="mt-3 inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-[6px] bg-primary text-[12px] text-text-inverse hover:bg-primary-hover disabled:opacity-60"
              >
                {pending ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <Sparkles size={13} strokeWidth={2} />
                )}
                {pending ? '研判中…' : '开始研判'}
              </button>
            </div>
          )
        ) : (
          <ol className="space-y-2">
            {hypotheses.map((hypothesis) => (
              <HypothesisCard
                key={hypothesis.id}
                hypothesis={hypothesis}
                incidentId={incidentId}
                verdictPending={verdictPendingId === hypothesis.id}
                onVerdict={(verdict) => setVerdict(hypothesis.id, verdict)}
              />
            ))}
          </ol>
        )}

        {error ? (
          <p className="mt-2 rounded-[6px] bg-surface-muted px-2 py-1.5 text-[10.5px] text-danger">
            {error}
          </p>
        ) : null}

        {analysis?.degradedReason && hypotheses.length > 0 ? (
          <p className="mt-2 text-[10px] leading-4 text-warn">{analysis.degradedReason}</p>
        ) : null}

        {analysis ? (
          <div className="mt-2">
            <VerifyBadge stats={analysis.verify.stats} dropped={analysis.verify.dropped} />
          </div>
        ) : null}

        {impactScope && hypotheses.length > 0 ? (
          <p className="mt-2 text-[10.5px] leading-4 text-text-secondary">{impactScope}</p>
        ) : null}
      </section>

      <section>
        <h2 className="mb-2 text-[13px] font-medium">
          可疑变更
          <span className="ml-1.5 font-mono text-[10px] font-normal text-text-tertiary">
            事件前 2h 内
          </span>
        </h2>
        {changes.length === 0 ? (
          <p className="rounded-[8px] border border-dashed border-border px-3 py-3 text-[11px] text-text-tertiary">
            该窗口内没有变更记录。若上游系统未接入变更数据，这里为空不代表没改过配置。
          </p>
        ) : (
          <ul className="space-y-1.5">
            {changes.map((change) => (
              <li
                key={change.id}
                className="rounded-[8px] border border-border bg-surface px-3 py-2"
              >
                <div className="flex items-center gap-1.5">
                  <span className="rounded-[3px] bg-surface-muted px-1 py-px text-[10px] text-warn">
                    {changeKindLabel(change.kind)}
                  </span>
                  <span className="font-mono text-[11px] text-text">{change.deviceName}</span>
                  <time
                    dateTime={change.changedAt}
                    title={absTime(change.changedAt)}
                    className="ml-auto font-mono text-[10px] text-text-tertiary"
                    suppressHydrationWarning
                  >
                    {relTime(change.changedAt)}
                  </time>
                </div>
                <p className="mt-1 text-[11px] leading-4 text-text-secondary">{change.content}</p>
                {change.operator ? (
                  <p className="mt-0.5 text-[10px] text-text-tertiary">操作人 {change.operator}</p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-[13px] font-medium">
          影响面
          <span className="ml-1.5 font-mono text-[10px] font-normal text-text-tertiary">
            {services.length} 个业务 · {devices.length} 台设备
          </span>
        </h2>

        {services.length > 0 ? (
          <ul className="mb-2 space-y-1">
            {services.map((service) => (
              <li
                key={service.id}
                className="rounded-[8px] border border-border bg-surface px-2.5 py-1.5"
              >
                <div className="flex items-center gap-1.5">
                  <span
                    className={cn(
                      'rounded-[3px] px-1 py-px text-[9.5px]',
                      service.tier === 1
                        ? 'bg-danger-soft text-danger'
                        : 'bg-surface-muted text-text-secondary',
                    )}
                  >
                    {SERVICE_TIER_LABEL[service.tier] ?? `T${service.tier}`}
                  </span>
                  <span className="text-[11.5px] font-medium text-text">{service.name}</span>
                  <span className="ml-auto font-mono text-[9.5px] text-text-tertiary">
                    {service.hitDevices.length} 台命中
                  </span>
                </div>
                <p className="mt-0.5 text-[10px] leading-4 text-text-tertiary">
                  {service.hitDevices.join('、')}
                  {service.owner ? ` · 业务负责人 ${service.owner}` : ''}
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mb-2 rounded-[8px] border border-dashed border-border px-2.5 py-2 text-[10px] leading-4 text-text-tertiary">
            未命中任何已登记的业务服务。这不代表没有业务受影响 —— 只说明受影响的设备
            还没被登记进服务依赖。
          </p>
        )}

        <ul className="space-y-1">
          {devices.map((device) => (
            <li key={device.id}>
              <button
                type="button"
                onClick={() => onSelectDevice?.(device.id)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-[6px] px-2 py-1.5 text-left transition-colors',
                  selectedDeviceId === device.id ? 'bg-primary-soft' : 'hover:bg-surface-muted',
                )}
              >
                <span className="font-mono text-[11px] text-text">{device.name}</span>
                <span className="text-[10px] text-text-tertiary">
                  {deviceLayerLabel(device.layer)}
                </span>
                <span className="ml-auto font-mono text-[10px] text-text-tertiary">
                  {device.suppressedCount > 0
                    ? `${device.alertCount} 条（${device.suppressedCount} 抑制）`
                    : `${device.alertCount} 条`}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

/**
 * 研判阶段进度（评审第 3 阶段「提供阶段进度，之后再升级为 SSE」）。
 *
 * 跑的时候看"现在到哪一步"，跑完看"每步花了多久" —— 后者才是能沉淀的东西：
 * 模型慢还是校验慢，一眼能分出来，不用去翻日志。
 */
function StageTimeline({ progress }: { progress: AnalysisProgress }) {
  const finished = new Map(
    progress.stages.filter((s) => s.finishedAt !== null).map((s) => [s.stage, s.durationMs ?? 0]),
  );
  const running = progress.status === 'RUNNING';

  return (
    <div className="mb-2 rounded-[6px] bg-surface-muted px-2 py-1.5">
      <ol className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[9.5px]">
        {STAGE_ORDER.map((stage, index) => {
          const done = finished.has(stage);
          const current = running && progress.stage === stage;
          return (
            <li key={stage} className="flex items-center gap-1">
              {index > 0 ? <span className="text-text-tertiary">›</span> : null}
              <span
                className={cn(
                  'inline-flex items-center gap-0.5',
                  done ? 'text-ok' : current ? 'text-primary' : 'text-text-tertiary',
                )}
              >
                {current ? <Loader2 size={8} className="animate-spin" /> : null}
                {STAGE_LABEL[stage]}
                {done ? (
                  <span className="font-mono text-[9px] text-text-tertiary">
                    {finished.get(stage)}ms
                  </span>
                ) : null}
              </span>
            </li>
          );
        })}
      </ol>
      {progress.status === 'DONE' ? (
        <p className="mt-1 font-mono text-[9px] text-text-tertiary">
          总耗时 {progress.durationMs ?? 0}ms
          {progress.stages.length > 0
            ? ` · ${progress.stages.map((s) => `${s.label} ${s.durationMs ?? 0}ms`).join(' / ')}`
            : ''}
        </p>
      ) : null}
      {progress.status === 'FAILED' ? (
        <p className="mt-1 text-[9.5px] text-danger">研判失败：{progress.error}</p>
      ) : null}
    </div>
  );
}
