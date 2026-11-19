'use client';

import { useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { AlertTable } from './alert-table';
import { HypothesisPanel } from './hypothesis-panel';
import { IncidentActions } from './incident-actions';
import { IncidentTimeline } from './incident-timeline';
import { ReportPanel } from './report-panel';
import { TopologyCanvas } from './topology-canvas';
import type { IncidentDetail } from '@/modules/incidents/detail';
import { resolveImpactScope } from '@/modules/topology/layout';
import type { TopologyGraph } from '@/modules/topology/service';

/**
 * 三栏工作台（文档 11.1 `/incidents/[id]`）。
 *
 * 三栏联动只共享一个状态：选中的设备。点拓扑节点、点时间线里的设备、点右栏影响面
 * 都会改它，中间告警表随之过滤。业务数据本身不进 store（11.2），全部来自 props。
 */
export function IncidentWorkspace({
  detail,
  topology,
  report,
}: {
  detail: IncidentDetail;
  topology: TopologyGraph;
  report: { id: string; markdown: string; createdAt: string } | null;
}) {
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);

  const affectedIds = useMemo(() => detail.devices.map((d) => d.id), [detail.devices]);
  const scope = useMemo(
    () => resolveImpactScope(affectedIds, topology.edges),
    [affectedIds, topology.edges],
  );

  const alerts = useMemo(
    () =>
      selectedDeviceId
        ? detail.alerts.filter((a) => a.deviceId === selectedDeviceId)
        : detail.alerts,
    [detail.alerts, selectedDeviceId],
  );

  const selectedDevice = detail.devices.find((d) => d.id === selectedDeviceId) ?? null;
  const toggle = (id: string) => setSelectedDeviceId((prev) => (prev === id ? null : id));

  return (
    <>
      <div className="grid min-h-[620px] grid-cols-1 gap-4 xl:grid-cols-[290px_minmax(0,1fr)_324px]">
        {/* 左：时间线 */}
        <section className="flex min-h-0 flex-col rounded-xl border border-border bg-surface shadow-card">
          <header className="flex items-center justify-between border-b border-border px-3 py-2">
            <h2 className="text-[13px] font-medium">时间线</h2>
            <span className="font-mono text-[10px] text-text-tertiary">
              {detail.timelineTotal} 条 · 含变更
            </span>
          </header>
          <div className="min-h-0 flex-1 overflow-auto px-3 py-2.5">
            <IncidentTimeline
              items={detail.timeline}
              total={detail.timelineTotal}
              truncated={detail.timelineTruncated}
              selectedDeviceId={selectedDeviceId}
              onSelectDevice={toggle}
            />
          </div>
        </section>

        {/* 中：拓扑高亮 + 告警明细 */}
        <section className="flex min-h-0 flex-col gap-3">
          <div className="rounded-xl border border-border bg-surface shadow-card">
            <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-3 py-2">
              <h2 className="text-[13px] font-medium">拓扑影响面</h2>
              <span className="font-mono text-[10px] text-text-tertiary">
                受影响 {scope.affected.length} · 直连 {scope.neighbors.length}
              </span>
              <div className="ml-auto flex items-center gap-3 text-[10px] text-text-tertiary">
                <Legend className="bg-danger-soft border-sev-p0" label="事件内" />
                <Legend className="bg-surface border-border-strong" label="直连" />
                <Legend className="bg-surface border-border" label="其它" />
              </div>
            </header>
            <div className="p-2">
              <TopologyCanvas
                nodes={topology.nodes}
                edges={topology.edges}
                affectedIds={affectedIds}
                selectedId={selectedDeviceId}
                onSelect={toggle}
                height={330}
                className="border-0"
              />
            </div>
          </div>

          <div className="flex min-h-0 flex-1 flex-col">
            <div className="mb-2 flex items-center gap-2">
              <h2 className="text-[13px] font-medium">关联告警</h2>
              <span className="font-mono text-[10px] text-text-tertiary">
                {alerts.length} / {detail.alerts.length}
              </span>
              {selectedDevice ? (
                <button
                  type="button"
                  onClick={() => setSelectedDeviceId(null)}
                  className="ml-auto inline-flex items-center gap-1 rounded-[4px] bg-primary-soft px-1.5 py-0.5 font-mono text-[10px] text-primary hover:bg-primary-soft/70"
                >
                  {selectedDevice.name}
                  <X size={10} strokeWidth={2} />
                </button>
              ) : (
                <span className="ml-auto text-[10px] text-text-tertiary">
                  点设备名或拓扑节点可筛选
                </span>
              )}
            </div>
            <AlertTable
              rows={alerts}
              selectedDeviceId={selectedDeviceId}
              onSelectDevice={toggle}
              maxHeight={280}
              emptyTitle={selectedDevice ? `${selectedDevice.name} 没有关联告警` : '暂无关联告警'}
              emptyHint="取消设备筛选可查看事件内全部告警。"
            />
          </div>
        </section>

        {/* 右：处理动作 + 根因与证据 */}
        <section className="min-h-0 space-y-3 overflow-auto rounded-xl border border-border bg-surface shadow-card px-3 py-3">
          <IncidentActions detail={detail} />
          <HypothesisPanel
            incidentId={detail.id}
            hypotheses={detail.hypotheses}
            analysis={detail.analysis}
            summary={detail.summary}
            impactScope={detail.impactScope}
            changes={detail.changes}
            devices={detail.devices}
            selectedDeviceId={selectedDeviceId}
            onSelectDevice={toggle}
          />
        </section>
      </div>

      <ReportPanel
        incidentId={detail.id}
        code={detail.code}
        status={detail.status}
        report={report}
      />
    </>
  );
}

function Legend({ className, label }: { className: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className={`size-2.5 rounded-[2px] border ${className}`} aria-hidden />
      {label}
    </span>
  );
}
