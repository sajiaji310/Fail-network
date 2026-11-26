import { Database, Sparkles } from 'lucide-react';
import { buttonClass } from '@/components/ui/button';
import { cn } from '@/lib/utils/cn';
import type { DbStatus } from '@/modules/system/service';

type Props = {
  db: DbStatus;
  llm: 'live' | 'mock' | 'fallback';
  stage: string;
  showLogout?: boolean;
};

const LLM_LABEL: Record<Props['llm'], string> = {
  live: 'LLM 在线',
  mock: 'LLM Mock',
  fallback: '规则降级',
};

/**
 * 顶栏做成半透明吸顶：滚动长页面（事件列表、详情）时环境状态始终可见，
 * 而且内容从下面透过去，视觉上比一条纯白横杠更轻。
 */
export function Topbar({ db, llm, stage, showLogout = false }: Props) {
  const dbUp = db === 'up';

  return (
    <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-3 border-b border-border bg-bg/75 px-6 backdrop-blur-xl">
      <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-2.5 py-[3px] shadow-pill">
        <span className="size-1.5 rounded-full bg-primary" aria-hidden />
        <span className="font-mono text-[10.5px] tracking-wide text-text-secondary">{stage}</span>
      </span>

      <div className="ml-auto flex items-center gap-2 text-[11.5px]">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-2.5 py-[3px] shadow-pill">
          <Database size={12} strokeWidth={1.7} className="text-text-tertiary" />
          <span
            className={cn(
              'size-1.5 rounded-full',
              dbUp ? 'bg-ok' : 'bg-danger',
              dbUp
                ? 'shadow-[0_0_0_3px_rgba(6,118,71,0.12)]'
                : 'shadow-[0_0_0_3px_rgba(180,35,24,0.12)]',
            )}
            aria-hidden
          />
          <span className={dbUp ? 'text-text-secondary' : 'font-medium text-danger'}>
            DB {dbUp ? '已连接' : '不可用'}
          </span>
        </span>

        <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-2.5 py-[3px] text-text-secondary shadow-pill">
          <Sparkles size={12} strokeWidth={1.7} className="text-text-tertiary" />
          {LLM_LABEL[llm]}
        </span>
        {showLogout ? (
          <form action="/api/console/logout" method="post">
            <button type="submit" className={buttonClass({ variant: 'ghost', size: 'sm' })}>
              退出
            </button>
          </form>
        ) : null}
      </div>
    </header>
  );
}
