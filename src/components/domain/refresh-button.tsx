'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { RefreshCw } from 'lucide-react';
import { buttonClass } from '@/components/ui/button';
import { cn } from '@/lib/utils/cn';

export function RefreshButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => startTransition(() => router.refresh())}
      className={cn(buttonClass({ variant: 'secondary', size: 'md' }), pending && 'opacity-60')}
    >
      <RefreshCw size={16} strokeWidth={1.5} className={pending ? 'animate-spin' : undefined} />
      {pending ? '检测中…' : '重新检测'}
    </button>
  );
}
