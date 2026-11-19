'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { absTime, relTime } from '@/lib/utils/time';
import { deviceLayerLabel } from '@/modules/alerts/labels';
import type { AnalysisMeta } from '@/modules/rca/schema';
import type { IncidentChange, IncidentDevice } from '@/modules/incidents/detail';
import type { HypothesisView } from '@/modules/incidents/hypothesis-view';
import { changeKindLabel } from '@/modules/incidents/timeline';
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
  selectedDeviceId = null,
  onSelectDevice,
}: HypothesisPanelProps) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [verdictPendingId, setVerdictPendingId] = useState<string | null>(null);
  const [confirmReanalyze, setConfirmReanalyze] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function analyze(force: boolean) {
    setPending(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/v1/incidents/${encodeURIComponent(incidentId)}/analyze${force ? '?force=1' : ''}`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        throw new Error(body?.error?.message ?? `研判失败（HTTP ${res.status}）`);
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : '研判失败');
    } finally {
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
          <h2 className="text-[13px] font-medium">根因研判</h2>
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
            {devices.length} 台设备
          </span>
        </h2>
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
