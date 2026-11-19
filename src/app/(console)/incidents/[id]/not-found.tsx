import Link from 'next/link';

export default function IncidentNotFound() {
  return (
    <div className="mx-auto max-w-[720px] py-16">
      <div className="rounded-[12px] border border-dashed border-border-strong bg-surface px-6 py-10 text-center">
        <p className="font-mono text-[13px] font-medium text-text-tertiary">404 NOT_FOUND</p>
        <h1 className="mt-1 text-[16px] font-medium">这个事件不存在</h1>
        <p className="mx-auto mt-2 max-w-[420px] text-[12px] leading-5 text-text-secondary">
          链接里的 ID 可能来自已清理的演示数据（
          <code className="font-mono">npm run sim -- --reset</code> 会删掉注入产生的事件）。
        </p>
        <div className="mt-4 flex items-center justify-center gap-2">
          <Link
            href="/incidents"
            className="inline-flex h-8 items-center rounded-[6px] bg-primary px-3 text-[12px] font-medium text-text-inverse hover:bg-primary-hover"
          >
            返回事件列表
          </Link>
          <Link
            href="/topology"
            className="inline-flex h-8 items-center rounded-[6px] border border-border-strong bg-surface px-3 text-[12px] font-medium text-text-secondary hover:bg-surface-muted hover:text-text"
          >
            查看拓扑
          </Link>
        </div>
      </div>
    </div>
  );
}
