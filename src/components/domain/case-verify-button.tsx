'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { BadgeCheck, Undo2 } from 'lucide-react';
import type { CaseVerification } from '@prisma/client';
import { buttonClass } from '@/components/ui/button';
import { cn } from '@/lib/utils/cn';

/**
 * 案例确认/驳回按钮（评审 P0-3）。
 *
 * 未验证的案例不进 RCA 召回 —— 这个按钮是它唯一的晋升通道。
 * 确认/驳回都调 `PATCH /api/v1/cases/[id]`，成功后就地刷新服务端组件，
 * 不自己维护一份本地状态：页面上的徽标必须以库里的值为准。
 */
export function CaseVerifyButton({
  caseId,
  verification,
}: {
  caseId: string;
  verification: CaseVerification;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<null | 'VERIFIED' | 'REJECTED' | 'UNVERIFIED'>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(next: 'VERIFIED' | 'REJECTED' | 'UNVERIFIED') {
    setPending(next);
    setError(null);
    try {
      const res = await fetch(`/api/v1/cases/${caseId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ verification: next }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { message?: string } };
        setError(body?.error?.message ?? `操作失败（HTTP ${res.status}）`);
        return;
      }
      router.refresh();
    } catch {
      setError('网络异常，请重试');
    } finally {
      setPending(null);
    }
  }

  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {verification === 'UNVERIFIED' ? (
        <>
          <button
            type="button"
            onClick={() => submit('VERIFIED')}
            disabled={pending !== null}
            className={cn(
              buttonClass({ variant: 'secondary', size: 'sm' }),
              'h-6 px-2 text-[10.5px]',
            )}
          >
            <BadgeCheck size={11} strokeWidth={2} />
            {pending === 'VERIFIED' ? '确认中…' : '确认有效'}
          </button>
          <button
            type="button"
            onClick={() => submit('REJECTED')}
            disabled={pending !== null}
            className={cn(
              buttonClass({ variant: 'ghost', size: 'sm' }),
              'h-6 px-2 text-[10.5px] text-text-tertiary',
            )}
          >
            {pending === 'REJECTED' ? '驳回中…' : '驳回'}
          </button>
        </>
      ) : (
        <button
          type="button"
          onClick={() => submit('UNVERIFIED')}
          disabled={pending !== null}
          className={cn(
            buttonClass({ variant: 'ghost', size: 'sm' }),
            'h-6 px-2 text-[10.5px] text-text-tertiary',
          )}
        >
          <Undo2 size={11} strokeWidth={2} />
          {pending === 'UNVERIFIED' ? '撤销中…' : '撤销结论'}
        </button>
      )}
      {error ? <span className="text-[10px] text-danger">{error}</span> : null}
    </span>
  );
}
