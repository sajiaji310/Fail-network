import { typeAffinity } from './affinity';
import { CLUSTER_WINDOW_MS, MAX_HOPS, TOPOLOGY_PROXIMITY, WEIGHTS } from './constants';
import type { DeviceGraph } from './topology';

/**
 * 聚合打分（文档 4.1）：
 *   score = 0.45 * topologyProximity + 0.30 * timeProximity + 0.25 * typeAffinity
 * 纯函数，不碰数据库 —— 调参与单测都在这一层完成。
 */

export type ScoreNode = {
  deviceId: string;
  type: string;
  /** 用告警首次出现时刻算时间距离：它才是"这条告警属于哪次故障"的锚点 */
  firstSeen: Date;
};

export function topologyProximity(graph: DeviceGraph, a: ScoreNode, b: ScoreNode): number {
  const hops = graph.hop(a.deviceId, b.deviceId);
  if (hops === 0) return TOPOLOGY_PROXIMITY.SAME_DEVICE;
  if (hops === 1) return TOPOLOGY_PROXIMITY.DIRECT;
  if (hops === 2) return TOPOLOGY_PROXIMITY.TWO_HOPS;
  return TOPOLOGY_PROXIMITY.NONE;
}

/** 1 - |Δt| / window，夹到 [0,1]；超过窗口记 0 */
export function timeProximity(
  a: Date | number,
  b: Date | number,
  windowMs: number = CLUSTER_WINDOW_MS,
): number {
  const ta = typeof a === 'number' ? a : a.getTime();
  const tb = typeof b === 'number' ? b : b.getTime();
  const delta = Math.abs(ta - tb);
  if (delta >= windowMs) return 0;
  return 1 - delta / windowMs;
}

/**
 * 是否落在同一 5 分钟窗口。
 *
 * 必须显式判断，不能只靠 timeProximity 归零：
 * 同设备(0.45)+同类型(0.25)=0.70 > 0.55，时间项归零也照样过阈值，
 * 于是"相隔 3 小时的同一告警"会被错误并进一个簇。
 */
export function withinWindow(
  a: ScoreNode,
  b: ScoreNode,
  windowMs: number = CLUSTER_WINDOW_MS,
): boolean {
  return Math.abs(a.firstSeen.getTime() - b.firstSeen.getTime()) <= windowMs;
}

export function scorePair(
  graph: DeviceGraph,
  a: ScoreNode,
  b: ScoreNode,
  windowMs: number = CLUSTER_WINDOW_MS,
): number {
  const score =
    WEIGHTS.TOPOLOGY * topologyProximity(graph, a, b) +
    WEIGHTS.TIME * timeProximity(a.firstSeen, b.firstSeen, windowMs) +
    WEIGHTS.TYPE * typeAffinity(a.type, b.type);
  // 浮点累加会出现 0.5499999，保留 4 位避免阈值判定抖动
  return Math.round(score * 10_000) / 10_000;
}

/**
 * 是否允许建立关联：B7 的硬闸门。
 *
 * 拓扑距离 > 2 跳时强制不关联 —— 即便公式算出来 ≥ 0.55 也一样。
 * （时间 1.0 + 类型 1.0 = 0.55 正好卡在阈值上，不加这道闸门必然误合并。）
 */
export function canRelate(graph: DeviceGraph, a: ScoreNode, b: ScoreNode): boolean {
  return graph.hop(a.deviceId, b.deviceId) <= MAX_HOPS;
}
