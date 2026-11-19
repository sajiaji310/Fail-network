/**
 * 拓扑画布的确定性分层布局（文档 11.1 `/topology`：按层级布局）。
 *
 * 为什么不用 dagre/elk：种子拓扑是严格的 1 核心 / 4 汇聚 / 25 接入三层，
 * 布局规则用几行就能说清；引图布局库反而让"为什么这个节点在这"变得不可测。
 * 纯函数 + 固定间距 = 同一份拓扑每次渲染位置完全一致（截图可比、E2E 可断言）。
 *
 * 层内换行（不是单行铺开）：25 台接入排一行会得到 4450px 宽的画布，
 * fitView 需要缩到 0.16，而 minZoom 通常卡在 0.25 → 直接被裁掉。
 * 按 8 列换行后宽度降到 ~1400px，缩放 0.5 左右仍可读。
 */

/** 节点尺寸与画布栅格，UI 与布局共用，避免两边各写一套魔法数字 */
export const NODE_WIDTH = 152;
export const NODE_HEIGHT = 48;
export const COL_GAP = 26;
/** 同一层内换行时的行距（比层间距小，视觉上仍属于同一层） */
export const ROW_GAP = 56;
/** 层与层之间的间距，留给连线 */
export const LAYER_GAP = 96;
export const MAX_LAYER = 3;
export const MAX_PER_ROW = 8;

export type LayoutDevice = { id: string; name: string; layer: number };
export type LayoutPosition = { id: string; x: number; y: number; layer: number; row: number };
export type LayoutResult = {
  positions: Map<string, LayoutPosition>;
  width: number;
  height: number;
  /** 每个层级实际占用的行数，调试/测试用 */
  rowsByLayer: Record<number, number>;
};

export function clampLayer(layer: number): number {
  if (!Number.isFinite(layer)) return MAX_LAYER;
  return Math.min(MAX_LAYER, Math.max(1, Math.trunc(layer)));
}

function chunk<T>(list: readonly T[], size: number): T[][] {
  const rows: T[][] = [];
  for (let i = 0; i < list.length; i += size) {
    rows.push(list.slice(i, i + size));
  }
  return rows;
}

function rowWidth(count: number): number {
  return count * NODE_WIDTH + Math.max(0, count - 1) * COL_GAP;
}

/**
 * 层内按名称排序、每行水平居中。
 * 名称排序而不是插入顺序：seed 顺序变了布局也不跳，diff 更干净。
 */
export function computeLayeredLayout(
  devices: readonly LayoutDevice[],
  options: { maxPerRow?: number } = {},
): LayoutResult {
  const maxPerRow = Math.max(1, options.maxPerRow ?? MAX_PER_ROW);

  const byLayer = new Map<number, LayoutDevice[]>();
  for (const device of devices) {
    const layer = clampLayer(device.layer);
    const list = byLayer.get(layer);
    if (list) list.push(device);
    else byLayer.set(layer, [device]);
  }

  for (const list of byLayer.values()) {
    list.sort((a, b) => a.name.localeCompare(b.name));
  }

  const layoutByLayer = new Map<number, LayoutDevice[][]>();
  const rowsByLayer: Record<number, number> = {};
  let width = NODE_WIDTH;

  for (const [layer, list] of byLayer) {
    const rows = chunk(list, maxPerRow);
    layoutByLayer.set(layer, rows);
    rowsByLayer[layer] = rows.length;
    for (const row of rows) {
      width = Math.max(width, rowWidth(row.length));
    }
  }

  const positions = new Map<string, LayoutPosition>();
  let cursorY = 0;

  for (const layer of [...layoutByLayer.keys()].sort((a, b) => a - b)) {
    const rows = layoutByLayer.get(layer)!;
    rows.forEach((row, rowIndex) => {
      const offsetX = (width - rowWidth(row.length)) / 2;
      const y = cursorY + rowIndex * (NODE_HEIGHT + ROW_GAP);
      row.forEach((device, index) => {
        positions.set(device.id, {
          id: device.id,
          layer,
          row: rowIndex,
          x: offsetX + index * (NODE_WIDTH + COL_GAP),
          y,
        });
      });
    });
    const blockHeight = rows.length * NODE_HEIGHT + (rows.length - 1) * ROW_GAP;
    cursorY += blockHeight + LAYER_GAP;
  }

  return {
    positions,
    width,
    height: positions.size === 0 ? NODE_HEIGHT : cursorY - LAYER_GAP,
    rowsByLayer,
  };
}

export type ImpactEdge = { sourceId: string; targetId: string };

/**
 * 影响面高亮集合：
 * - affected：事件内的设备（红）
 * - neighbors：与受影响设备直连、但自己没进事件的设备（灰蓝，提供"波及路径"上下文）
 *
 * 只算一跳邻居：两跳外的设备在本拓扑里几乎等于全网，标了也没有信息量。
 */
export function resolveImpactScope(
  affectedIds: readonly string[],
  edges: readonly ImpactEdge[],
): { affected: string[]; neighbors: string[] } {
  const affected = new Set(affectedIds);
  const neighbors = new Set<string>();

  for (const edge of edges) {
    const from = affected.has(edge.sourceId);
    const to = affected.has(edge.targetId);
    if (from === to) continue;
    neighbors.add(from ? edge.targetId : edge.sourceId);
  }

  return {
    affected: [...affected].sort(),
    neighbors: [...neighbors].sort(),
  };
}
