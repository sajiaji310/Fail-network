import { MAX_HOPS, UNREACHABLE_HOPS } from './constants';

/**
 * 拓扑邻接图（B1：聚合用**无向**邻接）。
 *
 * 为什么无向：链路两端互相影响，核心交换机挂了下游会一起报，只看方向会漏掉反向关联。
 * 有向只用于 T07 的根因排序（下游不能推出上游），两处刻意不复用同一份图。
 */
export type DeviceGraph = {
  /** 两设备间跳数：0 同设备，1 直连，2 两跳，>2 或不可达返回 UNREACHABLE_HOPS */
  hop(a: string, b: string): number;
  /** 两组设备之间的最小跳数（同组内任一设备到对方任一设备） */
  minHopBetween(a: readonly string[], b: readonly string[]): number;
  deviceCount: number;
};

export type LinkEdge = { sourceId: string; targetId: string };

export function buildDeviceGraph(edges: readonly LinkEdge[]): DeviceGraph {
  const adjacency = new Map<string, Set<string>>();

  const nodeOf = (id: string): Set<string> => {
    let set = adjacency.get(id);
    if (!set) {
      set = new Set<string>();
      adjacency.set(id, set);
    }
    return set;
  };

  for (const edge of edges) {
    if (edge.sourceId === edge.targetId) continue;
    // B1：双向都写，聚合阶段不关心方向
    nodeOf(edge.sourceId).add(edge.targetId);
    nodeOf(edge.targetId).add(edge.sourceId);
  }

  // 跳数结果在单次聚合里会被反复查（n² 对），必须缓存
  const memo = new Map<string, number>();

  function bfsHop(from: string, to: string): number {
    if (from === to) return 0;
    const visited = new Set<string>([from]);
    let frontier: string[] = [from];

    for (let depth = 1; depth <= MAX_HOPS; depth++) {
      const next: string[] = [];
      for (const node of frontier) {
        const neighbours = adjacency.get(node);
        if (!neighbours) continue;
        for (const nb of neighbours) {
          if (visited.has(nb)) continue;
          if (nb === to) return depth;
          visited.add(nb);
          next.push(nb);
        }
      }
      if (next.length === 0) break;
      frontier = next;
    }
    return UNREACHABLE_HOPS;
  }

  function hop(a: string, b: string): number {
    if (a === b) return 0;
    // 无向图距离对称，用排序后的键共享缓存
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    const value = bfsHop(a, b);
    memo.set(key, value);
    return value;
  }

  return {
    hop,
    minHopBetween(a, b) {
      let best = UNREACHABLE_HOPS;
      for (const from of a) {
        for (const to of b) {
          const h = hop(from, to);
          if (h < best) best = h;
          if (best === 0) return 0;
        }
      }
      return best;
    },
    deviceCount: adjacency.size,
  };
}
