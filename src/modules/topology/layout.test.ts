import { describe, expect, it } from 'vitest';
import {
  clampLayer,
  computeLayeredLayout,
  resolveImpactScope,
  COL_GAP,
  LAYER_GAP,
  NODE_HEIGHT,
  NODE_WIDTH,
  ROW_GAP,
} from './layout';

/** 单行层的起点：层号 1 起算，每层占 NODE_HEIGHT + LAYER_GAP */
const yOf = (layer: number) => (layer - 1) * (NODE_HEIGHT + LAYER_GAP);

describe('computeLayeredLayout', () => {
  it('按层级给出固定 y，同层水平排开', () => {
    const { positions } = computeLayeredLayout([
      { id: 'core', name: 'CORE-SW-01', layer: 1 },
      { id: 'agg1', name: 'AGG-SW-01', layer: 2 },
      { id: 'acc1', name: 'ACC-SW-01', layer: 3 },
    ]);

    expect(positions.get('core')?.y).toBe(yOf(1));
    expect(positions.get('agg1')?.y).toBe(yOf(2));
    expect(positions.get('acc1')?.y).toBe(yOf(3));
  });

  it('层内按名称排序，而不是按传入顺序', () => {
    const { positions } = computeLayeredLayout([
      { id: 'b', name: 'ACC-SW-02', layer: 3 },
      { id: 'a', name: 'ACC-SW-01', layer: 3 },
    ]);

    expect(positions.get('a')!.x).toBeLessThan(positions.get('b')!.x);
    expect(positions.get('b')!.x - positions.get('a')!.x).toBe(NODE_WIDTH + COL_GAP);
  });

  it('整层相对最宽层居中', () => {
    const { positions, width } = computeLayeredLayout([
      { id: 'a1', name: 'ACC-SW-01', layer: 3 },
      { id: 'a2', name: 'ACC-SW-02', layer: 3 },
      { id: 'a3', name: 'ACC-SW-03', layer: 3 },
      { id: 'c1', name: 'CORE-SW-01', layer: 1 },
    ]);

    const core = positions.get('c1')!;
    const acc = positions.get('a2')!;
    // 单节点层的中心与三节点层的中心重合
    expect(core.x + NODE_WIDTH / 2).toBeCloseTo(acc.x + NODE_WIDTH / 2, 6);
    expect(width).toBe(3 * NODE_WIDTH + 2 * COL_GAP);
  });

  it('一层超过 8 台时换行，行距小于层间距', () => {
    const devices = Array.from({ length: 9 }, (_, i) => ({
      id: `a${i}`,
      name: `ACC-SW-${String(i + 1).padStart(2, '0')}`,
      layer: 3,
    }));
    const result = computeLayeredLayout(devices);

    expect(result.rowsByLayer[3]).toBe(2);
    expect(result.positions.get('a0')?.row).toBe(0);
    expect(result.positions.get('a8')?.row).toBe(1);
    expect(result.positions.get('a8')!.y - result.positions.get('a0')!.y).toBe(
      NODE_HEIGHT + ROW_GAP,
    );
    expect(result.width).toBe(8 * NODE_WIDTH + 7 * COL_GAP);
    expect(result.height).toBe(2 * NODE_HEIGHT + ROW_GAP);
  });

  it('换行后最宽层宽度可控，不会撑出几千像素', () => {
    const devices = Array.from({ length: 25 }, (_, i) => ({
      id: `a${i}`,
      name: `ACC-SW-${String(i + 1).padStart(2, '0')}`,
      layer: 3,
    }));
    const result = computeLayeredLayout(devices);
    expect(result.width).toBe(8 * NODE_WIDTH + 7 * COL_GAP);
    expect(result.width).toBeLessThan(1600);
  });

  it('层号越界收敛到 1–3，脏数据不会把节点画到负坐标', () => {
    expect(clampLayer(0)).toBe(1);
    expect(clampLayer(-4)).toBe(1);
    expect(clampLayer(9)).toBe(3);
    expect(clampLayer(Number.NaN)).toBe(3);

    const { positions } = computeLayeredLayout([
      { id: 'x', name: 'X', layer: 0 },
      { id: 'y', name: 'Y', layer: 12 },
    ]);
    expect(positions.get('x')?.layer).toBe(1);
    expect(positions.get('y')?.layer).toBe(3);
    // 中间层没有设备时压缩空白，而不是留一整层空隙
    expect(positions.get('y')!.y).toBe(NODE_HEIGHT + LAYER_GAP);
    expect(positions.get('x')!.y).toBe(0);
  });

  it('空拓扑返回空布局，尺寸不为 0（画布不会塌陷）', () => {
    const result = computeLayeredLayout([]);
    expect(result.positions.size).toBe(0);
    expect(result.width).toBe(NODE_WIDTH);
    expect(result.height).toBe(NODE_HEIGHT);
  });
});

describe('resolveImpactScope', () => {
  const edges = [
    { sourceId: 'core', targetId: 'agg1' },
    { sourceId: 'core', targetId: 'agg2' },
    { sourceId: 'agg1', targetId: 'acc1' },
    { sourceId: 'agg1', targetId: 'acc2' },
  ];

  it('直连但未进事件的设备算邻居，不重复计入', () => {
    const scope = resolveImpactScope(['core'], edges);
    expect(scope.affected).toEqual(['core']);
    expect(scope.neighbors).toEqual(['agg1', 'agg2']);
  });

  it('邻居不会包含已受影响设备', () => {
    const scope = resolveImpactScope(['core', 'agg1'], edges);
    expect(scope.affected).toEqual(['agg1', 'core']);
    expect(scope.neighbors).toEqual(['acc1', 'acc2', 'agg2']);
    expect(scope.neighbors.some((id) => scope.affected.includes(id))).toBe(false);
  });

  it('孤立设备只影响自己', () => {
    const scope = resolveImpactScope(['orphan'], edges);
    expect(scope).toEqual({ affected: ['orphan'], neighbors: [] });
  });

  it('空输入安全', () => {
    expect(resolveImpactScope([], edges)).toEqual({ affected: [], neighbors: [] });
  });
});
