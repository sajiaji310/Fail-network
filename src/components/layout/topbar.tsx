import { Database, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import type { DbStatus } from '@/modules/system/service';

type Props = {
  db: DbStatus;
  llm: 'live' | 'mock' | 'fallback';
  stage: string;
};

const LLM_LABEL: Record<Props['llm'], string> = {
  live: 'LLM 在线',
  mock: 'LLM Mock',
  fallback: '规则降级',
};

export function Topbar({ db, llm, stage }: Props) {
  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-surface px-6">
      <span className="rounded-[6px] bg-surface-muted px-2 py-1 font-mono text-[11px] text-text-secondary">
        {stage}
      </span>

      <div className="ml-auto flex items-center gap-4 text-[12px]">
        <span className="flex items-center gap-1.5 text-text-secondary">
          <Database size={14} strokeWidth={1.5} />
          <span
            className={cn('size-1.5 rounded-full', db === 'up' ? 'bg-ok' : 'bg-danger')}
            aria-hidden
          />
          <span className={db === 'up' ? 'text-text-secondary' : 'text-danger'}>
            DB {db === 'up' ? '已连接' : '不可用'}
          </span>
        </span>

        <span className="flex items-center gap-1.5 text-text-secondary">
          <Sparkles size={14} strokeWidth={1.5} />
          {LLM_LABEL[llm]}
        </span>
      </div>
    </header>
  );
}
