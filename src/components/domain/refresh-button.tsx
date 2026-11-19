'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils/cn';

export function RefreshButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => startTransition(() => router.refresh())}
      className={cn(
        'inline-flex h-9 items-center gap-2 rounded-[8px] border border-border-strong bg-surface px-3 text-[13px] font-medium text-text-secondary',
        'transition-colors hover:bg-surface-muted hover:text-text',
        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary',
        pending && 'opacity-60',
      )}
    >
      <RefreshCw size={16} strokeWidth={1.5} className={pending ? 'animate-spin' : undefined} />
      {pending ? '检测中…' : '重新检测'}
    </button>
  );
}
