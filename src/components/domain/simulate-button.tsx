'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Play } from 'lucide-react';
import { buttonClass } from '@/components/ui/button';
import { cn } from '@/lib/utils/cn';

/**
 * "注入演示故障"按钮（文档 11.3：无数据可演示时给出可执行动作）。
 *
 * 直接打 `/api/v1/ingest/simulate`，成功后 refresh 由 Server Component 重新取数，
 * 避免在客户端维护一份事件缓存（11.2：业务数据一律不进 store）。
 */
export function SimulateButton({
  scenario = 'core-switch-board-failure',
  label = '注入演示故障',
  reset = false,
  variant = 'primary',
}: {
  scenario?: string;
  label?: string;
  reset?: boolean;
  variant?: 'primary' | 'ghost';
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setPending(true);
    setError(null);
    try {
      const res = await fetch('/api/v1/ingest/simulate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scenario, reset }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : '注入失败');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <button
        type="button"
        onClick={run}
        disabled={pending}
        className={cn(
          buttonClass({ variant, size: 'md' }),
          pending && 'cursor-progress opacity-70',
        )}
      >
        {pending ? (
          <Loader2 size={14} strokeWidth={2} className="animate-spin" />
        ) : (
          <Play size={14} strokeWidth={2} />
        )}
        {pending ? '注入中…' : label}
      </button>
      {error ? <p className="text-[11px] text-danger">注入失败：{error}</p> : null}
    </div>
  );
}
