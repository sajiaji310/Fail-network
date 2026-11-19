'use client';

import { useEffect } from 'react';
import { RotateCw } from 'lucide-react';

/** 错误态（11.3：展示错误码 + 重试按钮，禁止只弹 toast） */
export default function IncidentDetailError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // 浏览器控制台保留原始堆栈；页面只展示可复制的诊断信息
    console.error('[incident-detail]', error);
  }, [error]);

  return (
    <div className="mx-auto max-w-[720px] py-16">
      <div className="rounded-[12px] border border-border bg-surface px-6 py-8 text-center">
        <p className="font-mono text-[15px] font-medium text-danger">INTERNAL</p>
        <h1 className="mt-1 text-[16px] font-medium">事件详情加载失败</h1>
        <p className="mx-auto mt-2 max-w-[440px] text-[12px] leading-5 text-text-secondary">
          服务端取数时出错。若是刚重启过数据库，先执行{' '}
          <code className="font-mono">npm run db:start</code> 再重试。
        </p>
        <p className="mt-2 font-mono text-[11px] text-text-tertiary">
          digest: {error.digest ?? '—'}
        </p>
        <button
          type="button"
          onClick={reset}
          className="mt-4 inline-flex h-8 items-center gap-1.5 rounded-[6px] bg-primary px-3 text-[12px] font-medium text-text-inverse hover:bg-primary-hover"
        >
          <RotateCw size={14} strokeWidth={2} />
          重试
        </button>
      </div>
    </div>
  );
}
