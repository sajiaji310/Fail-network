'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Loader2, Pencil } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { clockTime } from '@/lib/utils/time';
import type { VerifyView } from '@/modules/incidents/hypothesis-view';

/**
 * 验证步骤勾选清单（评审第 3 阶段）。
 *
 * 三件事都在这里：勾选状态、操作者、结果备注。操作者由服务端从请求身份解析，
 * 前端不传 —— 一条"陈某验过了"的记录如果由前端自称，事后没人敢拿它当证据。
 */
export function VerifyChecklist({
  incidentId,
  hypothesisId,
  verify,
}: {
  incidentId: string;
  hypothesisId: string;
  verify: VerifyView;
}) {
  const router = useRouter();
  const [pendingIndex, setPendingIndex] = useState<number | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function submit(index: number, done: boolean, text?: string) {
    setPendingIndex(index);
    setError(null);
    try {
      const res = await fetch(
        `/api/v1/incidents/${encodeURIComponent(incidentId)}/hypotheses/${encodeURIComponent(hypothesisId)}/verify`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            stepIndex: index,
            done,
            ...(text && text.trim() ? { note: text.trim() } : {}),
          }),
        },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        throw new Error(body?.error?.message ?? `保存失败（HTTP ${res.status}）`);
      }
      setEditing(null);
      setNote('');
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setPendingIndex(null);
    }
  }

  return (
    <div className="mt-2 border-t border-border pt-2">
      <p className="flex items-center gap-1.5 text-[10px] font-medium text-text-secondary">
        验证步骤
        <span
          className={cn(
            'font-mono text-[9px]',
            verify.done === 0
              ? 'text-text-tertiary'
              : verify.done === verify.total
                ? 'text-ok'
                : 'text-warn',
          )}
        >
          {verify.done}/{verify.total}
        </span>
        {verify.done === verify.total && verify.total > 0 ? (
          <span className="text-[9px] text-ok">全部验证完成</span>
        ) : null}
      </p>

      <ul className="mt-1 space-y-0.5">
        {verify.steps.map((step) => (
          <li key={step.index}>
            <div className="flex items-start gap-1.5">
              <button
                type="button"
                onClick={() => submit(step.index, !step.done)}
                disabled={pendingIndex !== null}
                aria-pressed={step.done}
                aria-label={`${step.done ? '取消勾选' : '标记完成'}：${step.text}`}
                className={cn(
                  'mt-0.5 grid size-3.5 shrink-0 place-items-center rounded-[3px] border transition-colors',
                  step.done
                    ? 'border-ok bg-ok text-text-inverse'
                    : 'border-border-strong bg-surface hover:border-primary',
                  pendingIndex !== null && 'opacity-50',
                )}
              >
                {pendingIndex === step.index ? (
                  <Loader2 size={8} className="animate-spin" />
                ) : step.done ? (
                  <Check size={9} strokeWidth={3} />
                ) : null}
              </button>

              <div className="min-w-0 flex-1">
                <p
                  className={cn(
                    'text-[10.5px] leading-4 break-words',
                    step.done ? 'text-text-tertiary line-through' : 'text-text-secondary',
                  )}
                >
                  {step.text}
                </p>
                {step.done ? (
                  <p className="flex flex-wrap items-center gap-1 text-[9px] text-text-tertiary">
                    <span>
                      {step.by ?? '未知'} 验于{' '}
                      <time dateTime={step.at ?? undefined} suppressHydrationWarning>
                        {step.at ? clockTime(step.at) : '—'}
                      </time>
                    </span>
                    {step.note ? <span className="text-text-secondary">· {step.note}</span> : null}
                    <button
                      type="button"
                      onClick={() => {
                        setEditing(step.index);
                        setNote(step.note ?? '');
                      }}
                      className="inline-flex items-center gap-0.5 text-text-tertiary hover:text-primary"
                      aria-label="编辑验证备注"
                    >
                      <Pencil size={8} strokeWidth={2} />
                      备注
                    </button>
                  </p>
                ) : null}

                {editing === step.index ? (
                  <form
                    className="mt-1 flex items-center gap-1"
                    onSubmit={(event) => {
                      event.preventDefault();
                      submit(step.index, true, note);
                    }}
                  >
                    <input
                      value={note}
                      onChange={(event) => setNote(event.target.value)}
                      maxLength={300}
                      autoFocus
                      placeholder="验证结果，例：收光 -6dBm，已恢复正常"
                      className="h-6 min-w-0 flex-1 rounded-[4px] border border-border-strong bg-surface px-1.5 text-[10px] text-text outline-none focus:border-primary"
                    />
                    <button
                      type="submit"
                      disabled={pendingIndex !== null}
                      className="h-6 shrink-0 rounded-[4px] bg-primary px-1.5 text-[10px] text-text-inverse disabled:opacity-50"
                    >
                      保存
                    </button>
                  </form>
                ) : null}
              </div>
            </div>
          </li>
        ))}
      </ul>

      {error ? <p className="mt-1 text-[9.5px] leading-4 text-danger">{error}</p> : null}
    </div>
  );
}
