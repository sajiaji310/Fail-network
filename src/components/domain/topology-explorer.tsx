'use client';

import { useState } from 'react';
import Link from 'next/link';
import { TopologyCanvas } from './topology-canvas';
import { SeverityPill } from '@/components/ui/badges';
import { deviceLayerLabel } from '@/modules/alerts/labels';
import type { TopologyGraph } from '@/modules/topology/service';

/**
 * 拓扑页交互壳：画布只读，点节点在右栏看详情与关联事件。
 * 选中节点来自 URL 之外的状态即可——刷新后回到"未选中"是可接受的（不涉及业务数据）。
 */
export function TopologyExplorer({ graph }: { graph: TopologyGraph }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = graph.nodes.find((n) => n.id === selectedId) ?? null;

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_296px]">
      <div>
        <TopologyCanvas
          nodes={graph.nodes}
          edges={graph.edges}
          selectedId={selectedId}
          onSelect={(id) => setSelectedId((prev) => (prev === id ? null : id))}
          height={640}
        />
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-text-tertiary">
          <span>
            设备{' '}
            <span className="font-mono tabular text-text-secondary">{graph.stats.devices}</span> ·
            核心 {graph.stats.byLayer.core} / 汇聚 {graph.stats.byLayer.agg} / 接入{' '}
            {graph.stats.byLayer.access}
          </span>
          <span>
            链路 <span className="font-mono tabular text-text-secondary">{graph.stats.links}</span>
            {graph.stats.down > 0 ? (
              <span className="text-danger"> · DOWN {graph.stats.down}</span>
            ) : null}
            {graph.stats.degraded > 0 ? (
              <span className="text-warn"> · DEGRADED {graph.stats.degraded}</span>
            ) : null}
          </span>
          <span>
            有活跃告警的设备{' '}
            <span className="font-mono tabular text-text-secondary">
              {graph.stats.affectedDevices}
            </span>{' '}
            台
          </span>
          <span className="ml-auto">只读画布 · 拖拽平移、滚轮缩放</span>
        </div>
      </div>

      <aside className="rounded-[10px] border border-border bg-surface px-3 py-3">
        {selected ? (
          <div>
            <div className="flex items-center gap-2">
              <h2 className="font-mono text-[13px] font-medium">{selected.name}</h2>
              {selected.maxSeverity ? (
                <SeverityPill severity={selected.maxSeverity} compact />
              ) : null}
            </div>
            <dl className="mt-2 space-y-1 text-[11px]">
              <Row label="层级" value={deviceLayerLabel(selected.layer)} />
              <Row label="类型" value={selected.type} />
              <Row label="站点" value={selected.site ?? '—'} />
              <Row label="管理 IP" value={selected.ip ?? '—'} mono />
              <Row
                label="活跃告警"
                value={
                  selected.activeAlertCount > 0 ? (
                    <span className="font-mono text-danger">{selected.activeAlertCount} 条</span>
                  ) : (
                    <span className="font-mono text-text-tertiary">0</span>
                  )
                }
              />
            </dl>

            <h3 className="mt-3 text-[11px] font-medium text-text-secondary">关联事件</h3>
            {selected.incidents.length === 0 ? (
              <p className="mt-1 rounded-[6px] border border-dashed border-border px-2 py-2 text-[11px] text-text-tertiary">
                该设备当前没有活跃事件。
              </p>
            ) : (
              <ul className="mt-1 space-y-1">
                {selected.incidents.map((incident) => (
                  <li key={incident.id}>
                    <Link
                      href={`/incidents/${incident.id}`}
                      className="block rounded-[6px] px-2 py-1.5 hover:bg-surface-muted"
                    >
                      <span className="font-mono text-[10px] text-text-tertiary">
                        {incident.code}
                      </span>
                      <p className="line-clamp-1 text-[11px] text-text">{incident.title}</p>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <div className="pt-6 text-center">
            <p className="text-[12px] font-medium text-text">点一个设备</p>
            <p className="mx-auto mt-1 max-w-[220px] text-[11px] leading-4 text-text-tertiary">
              查看层级、站点与它当前卷入的活跃事件。红色节点表示该设备有活跃告警。
            </p>
          </div>
        )}
      </aside>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-text-tertiary">{label}</dt>
      <dd className={mono ? 'font-mono text-text' : 'text-text'}>{value}</dd>
    </div>
  );
}
