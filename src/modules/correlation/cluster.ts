import type { Severity } from '@prisma/client';
import { clusterKeyOf } from '../alerts/fingerprint';
import { CLUSTER_THRESHOLD } from './constants';
import { canRelate, scorePair, withinWindow } from './scoring';
import type { DeviceGraph } from './topology';

/**
 * 内存聚类：并查集 + 两两打分。
 *
 * 为什么不用"按设备分组"简化：故障会跨设备（核心挂了，下挂汇聚一起报），
 * 按设备分组只能得到孤岛。两两打分 500 条也就 12.5 万次比较，纯内存足够快。
 */

export type ClusterAlert = {
  id: string;
  fingerprintId: string;
  deviceId: string;
  deviceName: string;
  type: string;
  severity: Severity;
  firstSeen: Date;
  lastSeen: Date;
};

export type AlertCluster = {
  /** B8 幂等键 */
  key: string;
  alerts: ClusterAlert[];
  deviceIds: string[];
  /** 簇内最大两两关联分，用于候选事件打平判定（B2） */
  maxScore: number;
};

class UnionFind {
  private parent = new Map<string, string>();
  private rank = new Map<string, number>();

  find(x: string): string {
    const p = this.parent.get(x);
    if (p === undefined) {
      this.parent.set(x, x);
      this.rank.set(x, 0);
      return x;
    }
    if (p === x) return x;
    const root = this.find(p);
    this.parent.set(x, root); // 路径压缩
    return root;
  }

  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    const rankA = this.rank.get(ra) ?? 0;
    const rankB = this.rank.get(rb) ?? 0;
    if (rankA < rankB) {
      this.parent.set(ra, rb);
    } else if (rankA > rankB) {
      this.parent.set(rb, ra);
    } else {
      this.parent.set(rb, ra);
      this.rank.set(ra, rankA + 1);
    }
  }
}

export type ClusterOptions = {
  windowMs?: number;
  threshold?: number;
};

/**
 * 把告警聚成簇。返回的簇包含单条告警（size=1），
 * 是否成事件由调用方按 `MIN_ALERTS_PER_INCIDENT` 判断 —— 单条也要能沿用到已有事件（B5）。
 */
export function clusterAlerts(
  alerts: readonly ClusterAlert[],
  graph: DeviceGraph,
  options: ClusterOptions = {},
): AlertCluster[] {
  const windowMs = options.windowMs ?? undefined;
  const threshold = options.threshold ?? CLUSTER_THRESHOLD;

  // 确定性排序：同一批数据无论传入顺序如何，聚类结果必须一致（AC-17）
  const nodes = [...alerts].sort((a, b) => {
    const dt = a.firstSeen.getTime() - b.firstSeen.getTime();
    return dt !== 0 ? dt : a.id.localeCompare(b.id);
  });

  const uf = new UnionFind();
  // 先记录原始分数，最后再按根归并 —— 中途 union 会换根，边 union 边记 root 会丢分数
  const scored: Array<{ a: string; b: string; score: number }> = [];

  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i]!;
    for (let j = i + 1; j < nodes.length; j++) {
      const b = nodes[j]!;

      // B7 硬闸门：拓扑 > 2 跳直接跳过，不看分数
      if (!canRelate(graph, a, b)) continue;
      if (!withinWindow(a, b, windowMs)) continue;

      const score = scorePair(graph, a, b, windowMs);
      if (score < threshold) continue;

      uf.union(a.id, b.id);
      scored.push({ a: a.id, b: b.id, score });
    }
  }

  const groups = new Map<string, ClusterAlert[]>();
  for (const node of nodes) {
    const root = uf.find(node.id);
    const list = groups.get(root);
    if (list) list.push(node);
    else groups.set(root, [node]);
  }

  const clusters: AlertCluster[] = [];
  const maxScoreByRoot = new Map<string, number>();
  for (const { a, score } of scored) {
    const root = uf.find(a);
    const prev = maxScoreByRoot.get(root) ?? 0;
    if (score > prev) maxScoreByRoot.set(root, score);
  }

  for (const [root, list] of groups) {
    clusters.push({
      key: clusterKeyOf(list.map((a) => a.fingerprintId)),
      alerts: list,
      deviceIds: [...new Set(list.map((a) => a.deviceId))],
      maxScore: maxScoreByRoot.get(root) ?? 0,
    });
  }

  // 按最早告警时间排序，保证输出顺序稳定
  clusters.sort((a, b) => {
    const ta = a.alerts[0]?.firstSeen.getTime() ?? 0;
    const tb = b.alerts[0]?.firstSeen.getTime() ?? 0;
    return ta !== tb ? ta - tb : a.key.localeCompare(b.key);
  });

  return clusters;
}
