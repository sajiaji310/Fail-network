import Link from 'next/link';
import { TopologyExplorer } from '@/components/domain/topology-explorer';
import { buttonClass } from '@/components/ui/button';
import { getTopologyGraph } from '@/modules/topology/service';

export const dynamic = 'force-dynamic';

export default async function TopologyPage() {
  const graph = await getTopologyGraph();

  return (
    <div className="mx-auto max-w-[1440px]">
      <header className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[22px] leading-7 font-semibold tracking-tight">拓扑</h1>
          <p className="mt-0.5 text-[12px] text-text-secondary">
            三层结构只读视图 · 适用于影响面判断与聚合规则核对
          </p>
        </div>
        <Link href="/incidents" className={buttonClass({ variant: 'secondary', size: 'sm' })}>
          查看事件
        </Link>
      </header>

      {graph.nodes.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border-strong bg-surface px-6 py-14 text-center shadow-card">
          <p className="text-[14px] font-medium text-text">拓扑还是空的</p>
          <p className="mx-auto mt-1.5 max-w-[460px] text-[12px] leading-5 text-text-tertiary">
            设备与链路由种子脚本生成（30 设备 / 60 链路，1 核心 · 4 汇聚 · 25 接入）。 在终端执行{' '}
            <code className="font-mono text-text-secondary">npm run db:seed</code> 后刷新本页。
          </p>
          <Link
            href="/overview"
            className={buttonClass({
              variant: 'primary',
              size: 'sm',
              className: 'mt-4',
            })}
          >
            回到概览查看自检
          </Link>
        </div>
      ) : (
        <TopologyExplorer graph={graph} />
      )}
    </div>
  );
}
