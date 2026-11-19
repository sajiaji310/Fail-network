'use client';

import { useCallback, useMemo } from 'react';
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
  type NodeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { deviceLayerLabel } from '@/modules/alerts/labels';
import {
  computeLayeredLayout,
  resolveImpactScope,
  NODE_HEIGHT,
  NODE_WIDTH,
} from '@/modules/topology/layout';
import type { TopologyEdge, TopologyNode } from '@/modules/topology/service';
import { cn } from '@/lib/utils/cn';

/**
 * 只读拓扑画布（文档 11.1 `/topology`）。
 *
 * 只读不是"暂时没做编辑"，而是刻意：编辑属外围能力（评审第 7 条降 P1），
 * 但影响面高亮是 demo 唯一能一眼看懂"这事影响了谁"的载体，所以必须可点可看。
 */

type DeviceNodeData = {
  name: string;
  meta: string;
  /** affected 红 / neighbor 蓝灰 / normal 淡化 */
  state: 'affected' | 'neighbor' | 'normal';
  alertCount: number;
  selected: boolean;
};

type DeviceFlowNode = Node<DeviceNodeData, 'device'>;

function DeviceNode({ data }: NodeProps<DeviceFlowNode>) {
  return (
    <div
      className={cn(
        'flex h-full w-full flex-col justify-center gap-0.5 rounded-[8px] border bg-surface px-2.5 text-left shadow-[0_1px_2px_rgba(16,24,40,0.06)]',
        data.state === 'affected'
          ? 'border-sev-p0 bg-[#FEF3F2]'
          : data.state === 'neighbor'
            ? 'border-border-strong'
            : 'border-border opacity-60',
        data.selected && 'ring-2 ring-primary ring-offset-1',
      )}
    >
      <Handle type="target" position={Position.Top} className="!size-0 !border-0 !bg-transparent" />
      <span className="flex items-center gap-1 truncate text-[12px] font-medium leading-tight text-text">
        {data.name}
        {data.alertCount > 0 ? (
          <span className="rounded-[3px] bg-sev-p0 px-1 font-mono text-[9px] leading-4 text-text-inverse">
            {data.alertCount}
          </span>
        ) : null}
      </span>
      <span className="truncate font-mono text-[10px] leading-tight text-text-tertiary">
        {data.meta}
      </span>
      <Handle
        type="source"
        position={Position.Bottom}
        className="!size-0 !border-0 !bg-transparent"
      />
    </div>
  );
}

const nodeTypes = { device: DeviceNode } as NodeTypes;

export type TopologyCanvasProps = {
  nodes: readonly TopologyNode[];
  edges: readonly TopologyEdge[];
  /** 事件内设备：红色高亮 */
  affectedIds?: readonly string[];
  selectedId?: string | null;
  onSelect?: (deviceId: string) => void;
  height?: number;
  className?: string;
  /** 是否显示缩放控件与背景栅格（工作台内嵌时可关） */
  controls?: boolean;
};

export function TopologyCanvas({
  nodes,
  edges,
  affectedIds = [],
  selectedId = null,
  onSelect,
  height = 420,
  className,
  controls = true,
}: TopologyCanvasProps) {
  const { flowNodes, flowEdges } = useMemo(() => {
    const layout = computeLayeredLayout(nodes);
    const scope = resolveImpactScope(affectedIds, edges);
    const affected = new Set(scope.affected);
    const neighbors = new Set(scope.neighbors);

    const nextNodes: Node<DeviceNodeData>[] = nodes.map((device) => {
      const position = layout.positions.get(device.id);
      const state: DeviceNodeData['state'] = affected.has(device.id)
        ? 'affected'
        : neighbors.has(device.id)
          ? 'neighbor'
          : 'normal';

      return {
        id: device.id,
        type: 'device',
        position: { x: position?.x ?? 0, y: position?.y ?? 0 },
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
        draggable: false,
        data: {
          name: device.name,
          meta: `${deviceLayerLabel(device.layer)} · ${device.site ?? '未标注站点'}`,
          state,
          alertCount: device.activeAlertCount,
          selected: device.id === selectedId,
        },
        style: { width: NODE_WIDTH, height: NODE_HEIGHT },
      };
    });

    const nextEdges: Edge[] = edges.map((edge) => {
      const bothAffected = affected.has(edge.sourceId) && affected.has(edge.targetId);
      const touched = affected.has(edge.sourceId) || affected.has(edge.targetId);
      const stroke =
        edge.status === 'DOWN'
          ? 'var(--color-danger)'
          : edge.status === 'DEGRADED'
            ? 'var(--color-warn)'
            : bothAffected
              ? 'var(--color-sev-p0)'
              : 'var(--color-border-strong)';

      return {
        id: edge.id,
        source: edge.sourceId,
        target: edge.targetId,
        type: 'smoothstep',
        style: {
          stroke,
          strokeWidth: bothAffected ? 1.8 : 1,
          opacity: touched ? 0.95 : 0.45,
          strokeDasharray: edge.status === 'DEGRADED' ? '4 3' : undefined,
        },
      };
    });

    return { flowNodes: nextNodes, flowEdges: nextEdges };
  }, [nodes, edges, affectedIds, selectedId]);

  const handleNodeClick = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      onSelect?.(node.id);
    },
    [onSelect],
  );

  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-[10px] border border-border bg-bg',
        className,
      )}
      style={{ height }}
    >
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        onNodeClick={handleNodeClick}
        fitView
        fitViewOptions={{ padding: 0.15, maxZoom: 1.15 }}
        minZoom={0.2}
        maxZoom={1.6}
        nodesDraggable={false}
        nodesConnectable={false}
        edgesFocusable={false}
        elementsSelectable
        proOptions={{ hideAttribution: true }}
      >
        {controls ? <Controls showInteractive={false} position="bottom-right" /> : null}
        <Background gap={16} size={1} color="var(--color-border)" />
      </ReactFlow>
    </div>
  );
}
