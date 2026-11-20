/**
 * 拓扑完整度（评审 P0-4）。
 *
 * 缺拓扑时聚合与归因都会退化，但退化的原因必须让用户看见 —— 否则一条
 * "证据不足的候选"会被当成根因结论照做。这个模块只做纯计算：给定事件内设备
 * 和当前库里的全部链路，回答三个问题：
 *
 *   1. 事件里的设备有没有链路记录？（没有任何一条 = 完全缺失）
 *   2. 这些设备在拓扑上是否连通？（分裂成多个连通分量 = 扩散路径断了）
 *   3. 有多少台设备是孤岛？
 *
 * 判级刻意保守：只要有一台设备没有链路，就降为 PARTIAL。宁可多提示一次
 * "结论仅供参考"，也不要在缺数据时给出满格置信度。
 */

export type TopologyLevel = 'FULL' | 'PARTIAL' | 'MISSING';

export type TopologyCoverage = {
  level: TopologyLevel;
  /** 事件内设备数 */
  deviceCount: number;
  /** 至少有一条链路记录的设备数 */
  linkedDevices: number;
  /** 无任何链路记录的设备（用于页面上点名"缺谁"） */
  isolatedDevices: { id: string; name: string }[];
  /** 触及事件设备的链路条数 */
  linkCount: number;
  /** 事件设备在拓扑上的连通分量数（>1 说明扩散路径缺链） */
  components: number;
  /**
   * 事件设备之间的最大跳数（超过 2 记为 3）。
   *
   * 为什么它是缺拓扑的信号：聚合与根因排序都只在 2 跳内认为"相关"，
   * 一场故障却横跨 3 跳以上，通常是中间那段链路没采到（dev-13 就是这样：
   * 核心到汇聚的上联缺失，只能绕行汇聚链连过去）。这是推断，不是事实，
   * 所以判 PARTIAL 而不是直接判"数据错误"。
   */
  maxHops: number;
  /** linkedDevices / deviceCount */
  ratio: number;
};

export type LinkInput = { sourceId: string; targetId: string };
export type DeviceInput = { id: string; name: string };

/** 不同完整度下根因置信度上限：缺数据就不该给"接近确定" */
export const CONFIDENCE_CAP: Record<TopologyLevel, number> = {
  FULL: 1,
  PARTIAL: 0.75,
  MISSING: 0.55,
};

export const TOPOLOGY_LEVEL_LABEL: Record<TopologyLevel, string> = {
  FULL: '拓扑完整',
  PARTIAL: '拓扑部分缺失',
  MISSING: '拓扑完全缺失',
};

export function capConfidence(confidence: number, level: TopologyLevel): number {
  const cap = CONFIDENCE_CAP[level];
  return Math.round(Math.min(confidence, cap) * 1000) / 1000;
}

/**
 * 连通分量数：只统计事件设备之间是否可达，路径允许经过非事件设备
 * （核心到汇聚的链路径常经过中间设备，只按直连判定会把正常拓扑误判成断裂）。
 */
function countComponents(deviceIds: readonly string[], links: readonly LinkInput[]): number {
  if (deviceIds.length <= 1) return deviceIds.length;

  const adjacency = new Map<string, Set<string>>();
  const add = (a: string, b: string) => {
    let set = adjacency.get(a);
    if (!set) {
      set = new Set<string>();
      adjacency.set(a, set);
    }
    set.add(b);
  };
  for (const link of links) {
    if (link.sourceId === link.targetId) continue;
    add(link.sourceId, link.targetId);
    add(link.targetId, link.sourceId);
  }

  // seen 里包含中间节点，但外层只遍历事件设备，所以中间节点不会被误算成一个分量
  const seen = new Set<string>();
  let components = 0;

  for (const id of deviceIds) {
    if (seen.has(id)) continue;
    components += 1;
    const queue = [id];
    seen.add(id);
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const next of adjacency.get(current) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        queue.push(next);
      }
    }
  }

  return components;
}

/**
 * 事件设备之间的最大跳数，只数到 3（3 代表"超过 2 跳"）。
 * 与聚合的 2 跳阈值对齐：2 跳内是算法认为"相关"的范围。
 */
const MAX_TRACKED_HOPS = 3;

function maxHopsBetween(deviceIds: readonly string[], links: readonly LinkInput[]): number {
  if (deviceIds.length <= 1) return 0;
  const adjacency = new Map<string, Set<string>>();
  const add = (a: string, b: string) => {
    let set = adjacency.get(a);
    if (!set) {
      set = new Set<string>();
      adjacency.set(a, set);
    }
    set.add(b);
  };
  for (const link of links) {
    if (link.sourceId === link.targetId) continue;
    add(link.sourceId, link.targetId);
    add(link.targetId, link.sourceId);
  }

  const targets = new Set(deviceIds);
  let widest = 0;
  for (const start of deviceIds) {
    const seen = new Set<string>([start]);
    let frontier = [start];
    let depth = 0;
    while (frontier.length > 0 && depth < MAX_TRACKED_HOPS) {
      depth += 1;
      const next: string[] = [];
      for (const node of frontier) {
        for (const nb of adjacency.get(node) ?? []) {
          if (seen.has(nb)) continue;
          seen.add(nb);
          next.push(nb);
          if (targets.has(nb) && depth > widest) widest = depth;
        }
      }
      frontier = next;
    }
    if (widest >= MAX_TRACKED_HOPS) return MAX_TRACKED_HOPS;
  }
  return widest;
}

export function assessTopology(
  devices: readonly DeviceInput[],
  links: readonly LinkInput[],
): TopologyCoverage {
  const ids = new Set(devices.map((d) => d.id));
  const touched = links.filter((l) => ids.has(l.sourceId) || ids.has(l.targetId));

  const linked = new Set<string>();
  for (const link of touched) {
    if (ids.has(link.sourceId)) linked.add(link.sourceId);
    if (ids.has(link.targetId)) linked.add(link.targetId);
  }

  const isolatedDevices = devices.filter((d) => !linked.has(d.id));
  const components = countComponents(
    devices.map((d) => d.id),
    links,
  );
  const maxHops = maxHopsBetween(
    devices.map((d) => d.id),
    links,
  );

  const deviceCount = devices.length;
  const level: TopologyLevel =
    deviceCount === 0 || linked.size === 0
      ? 'MISSING'
      : isolatedDevices.length > 0 || components > 1 || maxHops > 2
        ? 'PARTIAL'
        : 'FULL';

  return {
    level,
    deviceCount,
    linkedDevices: linked.size,
    isolatedDevices,
    linkCount: touched.length,
    components,
    maxHops,
    ratio: deviceCount === 0 ? 0 : Math.round((linked.size / deviceCount) * 1000) / 1000,
  };
}

/** 面向用户的一句话说明；FULL 时返回 null（页面上不打扰） */
export function coverageNote(coverage: TopologyCoverage): string | null {
  if (coverage.level === 'FULL') return null;
  const missing = coverage.isolatedDevices.map((d) => d.name);
  if (coverage.level === 'MISSING') {
    return `事件内 ${coverage.deviceCount} 台设备都没有链路记录，拓扑关联与根因排序只能基于时间与告警类型，结论按候选排序展示。`;
  }
  const parts: string[] = [`${missing.length} 台设备没有链路记录`];
  if (missing.length > 0)
    parts.push(`（${missing.slice(0, 4).join('、')}${missing.length > 4 ? ' 等' : ''}）`);
  if (coverage.components > 1) {
    parts.push(`事件设备在拓扑上分成 ${coverage.components} 个互不相连的部分，扩散路径可能缺链`);
  } else if (coverage.maxHops > 2) {
    parts.push('事件设备之间最远超过 2 跳，中间的链路可能没采到');
  }
  return `${parts.join('，')}。结论按候选排序展示，置信度已按完整度下调。`;
}
