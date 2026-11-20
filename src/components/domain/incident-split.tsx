'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Split } from 'lucide-react';

/**
 * 事件拆分入口（评审第 2 阶段）。
 *
 * 只做一件事：把当前勾选的告警 POST 到 split 接口，成功后跳到新事件。
 * 为什么不做"拖拽分组"：拆分是纠错动作，不是日常操作，低频、需要二次确认，
 * 一个按钮 + 一句备注足够；做复杂了反而让人不敢用。
 */
export function SplitButton({
  incidentId,
  alertIds,
  totalAlerts,
  onDone,
}: {
  incidentId: string;
  alertIds: readonly string[];
  /** 原事件的告警总数：拆走全部是不允许的，前端先给出提示 */
  totalAlerts: number;
  onDone?: () => void;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const count = alertIds.length;
  const all = count >= totalAlerts;

  async function submit() {
    setPending(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/incidents/${encodeURIComponent(incidentId)}/split`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ alertIds, ...(note.trim() ? { note: note.trim() } : {}) }),
      });
      const body = (await res.json().catch(() => null)) as {
        error?: { message?: string };
        target?: { id: string; code: string };
      } | null;
      if (!res.ok || !body?.target) {
        throw new Error(body?.error?.message ?? `拆分失败（HTTP ${res.status}）`);
      }
      setOpen(false);
      onDone?.();
      router.push(`/incidents/${body.target.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : '拆分失败');
    } finally {
      setPending(false);
    }
  }

  if (count === 0) return null;

  return (
    <div className="ml-auto flex items-center gap-2">
      {open ? (
        <>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="拆分原因（可选，会写进事件记录与审计）"
            maxLength={200}
            className="h-6 w-[240px] rounded-[4px] border border-border bg-surface px-1.5 text-[10.5px] outline-none focus:border-primary"
          />
          {all ? <span className="text-[10px] text-danger">不能拆走全部告警</span> : null}
          <button
            type="button"
            onClick={submit}
            disabled={pending || all}
            className="inline-flex h-6 items-center gap-1 rounded-[4px] bg-primary px-2 text-[10.5px] text-text-inverse hover:bg-primary-hover disabled:opacity-50"
          >
            {pending ? <Loader2 size={10} className="animate-spin" /> : null}
            确认拆出 {count} 条
          </button>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              setError(null);
            }}
            className="text-[10.5px] text-text-tertiary hover:text-text"
          >
            取消
          </button>
        </>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          title="把选中的告警拆到新事件；拆分后两侧不会再被自动合并"
          className="inline-flex h-6 items-center gap-1 rounded-[4px] border border-border bg-surface px-2 text-[10.5px] text-text-secondary hover:border-border-strong hover:text-text"
        >
          <Split size={11} strokeWidth={2} />
          拆出 {count} 条
        </button>
      )}
      {error ? <span className="text-[10px] text-danger">{error}</span> : null}
    </div>
  );
}
