'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { IncidentStatus } from '@prisma/client';
import { ArrowRight, Loader2, X } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { absTime, clockTime } from '@/lib/utils/time';
import { IncidentStatusPill } from '@/components/ui/badges';
import type { IncidentDetail } from '@/modules/incidents/detail';
import { nextStatuses } from '@/modules/incidents/stateMachine';
import {
  INCIDENT_ACTION_HINT,
  INCIDENT_ACTION_LABEL,
  INCIDENT_STATUS_LABEL,
} from '@/modules/incidents/status';

/**
 * 人工确认与结案（T08）。
 *
 * 两个刻意的选择：
 * 1. **列出全部合法目标而不是"下一步"**：允许跳级，就要让人看见能直接结案。
 * 2. **结案一定是弹窗 + 动词按钮**（11.3 危险操作）：结案会写 MTTR、沉淀案例、
 *    生成报告，且不可回退 —— 这不是一个该被误点的按钮。
 */
export function IncidentActions({ detail }: { detail: IncidentDetail }) {
  const router = useRouter();
  const [pending, setPending] = useState<IncidentStatus | null>(null);
  const [confirming, setConfirming] = useState<IncidentStatus | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const targets = nextStatuses(detail.status);
  const accepted = detail.hypotheses.find((h) => h.verdict === 'ACCEPTED') ?? null;

  async function submit(to: IncidentStatus) {
    setPending(to);
    setError(null);
    try {
      const res = await fetch(`/api/v1/incidents/${encodeURIComponent(detail.id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: to, ...(note.trim() ? { note: note.trim() } : {}) }),
      });
      const body = (await res.json().catch(() => null)) as {
        error?: { code?: string; message?: string };
      } | null;

      if (!res.ok) {
        if (res.status === 409 && body?.error?.code === 'INVALID_TRANSITION') {
          throw new Error(`${body.error.message ?? '状态已变化'}（他人已推进，页面将刷新）`);
        }
        throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
      }

      setConfirming(null);
      setNote('');
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : '状态流转失败');
      router.refresh();
    } finally {
      setPending(null);
    }
  }

  return (
    <section className="rounded-[10px] bg-surface-muted/60 px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-[13px] font-medium">处理动作</h2>
        <IncidentStatusPill status={detail.status} />
      </div>

      {targets.length === 0 ? (
        <p className="mt-1.5 text-[10.5px] leading-4 text-text-tertiary">
          已归档，流程结束。如需重新跟进，只能新建事件。
        </p>
      ) : (
        <>
          <p className="mt-1 text-[10.5px] leading-4 text-text-tertiary">
            状态只能向前推进，结案后不可回退。
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {targets.map((to) => (
              <button
                key={to}
                type="button"
                onClick={() => {
                  setError(null);
                  setConfirming(to);
                }}
                disabled={pending !== null}
                className={cn(
                  'inline-flex h-8 items-center gap-1 rounded-[7px] border px-2.5 text-[11.5px] font-medium shadow-pill transition-colors',
                  to === 'RESOLVED'
                    ? 'border-danger/40 bg-danger-soft text-danger hover:bg-danger/10'
                    : 'border-border-strong/80 bg-surface text-text-secondary hover:text-text',
                  pending !== null && 'cursor-not-allowed opacity-50',
                )}
              >
                {INCIDENT_ACTION_LABEL[to] ?? INCIDENT_STATUS_LABEL[to]}
                <ArrowRight size={10} strokeWidth={2} />
              </button>
            ))}
          </div>
        </>
      )}

      {accepted ? (
        <p className="mt-2 rounded-[6px] bg-ok-soft px-2 py-1 text-[10.5px] leading-4 text-ok">
          已采纳：{accepted.cause}
        </p>
      ) : targets.length > 0 ? (
        <p className="mt-2 text-[10.5px] leading-4 text-warn">
          未采纳任何假设，结案报告的「根因」会标注为未人工确认。
        </p>
      ) : null}

      {error ? (
        <p className="mt-2 rounded-[6px] bg-danger-soft px-2 py-1 text-[10.5px] leading-4 text-danger">
          {error}
        </p>
      ) : null}

      {detail.closure ? (
        <div className="mt-2 rounded-[6px] bg-surface-muted px-2 py-1.5 text-[10.5px] leading-4 text-text-secondary">
          <p>
            结案于 {absTime(detail.closure.at)}
            {detail.closure.acceptedCause
              ? ` · 采纳根因：${detail.closure.acceptedCause}`
              : ' · 未采纳任何假设'}
          </p>
          {detail.closure.note ? <p className="mt-0.5">备注：{detail.closure.note}</p> : null}
        </div>
      ) : null}

      {detail.statusLog.length > 0 ? (
        <details className="mt-2 border-t border-border pt-1.5">
          <summary className="cursor-pointer list-none text-[10px] text-text-tertiary hover:text-text">
            流转记录 {detail.statusLog.length} 条
          </summary>
          <ol className="mt-1 space-y-0.5">
            {detail.statusLog.map((entry, index) => (
              <li key={`${entry.at}-${index}`} className="text-[10px] leading-4 text-text-tertiary">
                <time dateTime={entry.at} title={absTime(entry.at)}>
                  {clockTime(entry.at)}
                </time>{' '}
                {INCIDENT_STATUS_LABEL[entry.from]} → {INCIDENT_STATUS_LABEL[entry.to]}
                {entry.note ? ` · ${entry.note}` : ''}
              </li>
            ))}
          </ol>
        </details>
      ) : null}

      {confirming ? (
        <ConfirmDialog
          target={confirming}
          from={detail.status}
          note={note}
          onNote={setNote}
          pending={pending === confirming}
          onCancel={() => {
            setConfirming(null);
            setError(null);
          }}
          onConfirm={() => submit(confirming)}
        />
      ) : null}
    </section>
  );
}

function ConfirmDialog({
  target,
  from,
  note,
  onNote,
  pending,
  onCancel,
  onConfirm,
}: {
  target: IncidentStatus;
  from: IncidentStatus;
  note: string;
  onNote: (value: string) => void;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const danger = target === 'RESOLVED';
  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-overlay/45 p-4 backdrop-blur-[2px]"
      role="dialog"
      aria-modal="true"
      aria-label={`${INCIDENT_ACTION_LABEL[target] ?? target}确认`}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !pending) onCancel();
      }}
    >
      <div className="w-full max-w-[420px] rounded-xl border border-border bg-surface p-4 shadow-raised">
        <div className="flex items-start justify-between gap-3">
          <h3 className="text-[14px] font-medium">
            {INCIDENT_ACTION_LABEL[target] ?? INCIDENT_STATUS_LABEL[target]}
            <span className="ml-1.5 font-normal text-text-tertiary">
              {INCIDENT_STATUS_LABEL[from]} → {INCIDENT_STATUS_LABEL[target]}
            </span>
          </h3>
          <button
            type="button"
            onClick={onCancel}
            disabled={pending}
            aria-label="关闭"
            className="text-text-tertiary hover:text-text disabled:opacity-50"
          >
            <X size={14} strokeWidth={2} />
          </button>
        </div>

        <p className="mt-2 text-[11.5px] leading-5 text-text-secondary">
          {INCIDENT_ACTION_HINT[target]}
        </p>

        <label className="mt-3 block text-[11px] text-text-secondary">
          {danger ? '结案备注（写进报告，可选）' : '备注（可选）'}
          <textarea
            value={note}
            onChange={(event) => onNote(event.target.value)}
            rows={danger ? 3 : 2}
            maxLength={500}
            placeholder={danger ? '例：更换 CORE-SW-01 板卡后恢复正常，已观察 30 分钟无新告警' : ''}
            className="mt-1 w-full resize-none rounded-[6px] border border-border-strong bg-surface px-2 py-1.5 text-[11.5px] leading-5 text-text outline-none focus:border-primary"
          />
        </label>

        {danger ? (
          <p className="mt-2 rounded-[6px] bg-warn-soft px-2 py-1.5 text-[10.5px] leading-4 text-warn">
            结案将写入 MTTR 与结案记录，自动沉淀一条案例并生成复盘报告。此操作不可撤回。
          </p>
        ) : null}

        <div className="mt-3 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={pending}
            className="h-8 rounded-[6px] border border-border-strong bg-surface px-3 text-[12px] text-text-secondary hover:bg-surface-muted disabled:opacity-50"
          >
            取消
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={pending}
            className={cn(
              'inline-flex h-8 items-center gap-1.5 rounded-[6px] px-3 text-[12px] font-medium text-text-inverse disabled:opacity-60',
              danger ? 'bg-danger hover:bg-danger/90' : 'bg-primary hover:bg-primary-hover',
            )}
          >
            {pending ? <Loader2 size={13} className="animate-spin" /> : null}
            {pending ? '提交中…' : (INCIDENT_ACTION_LABEL[target] ?? INCIDENT_STATUS_LABEL[target])}
          </button>
        </div>
      </div>
    </div>
  );
}
