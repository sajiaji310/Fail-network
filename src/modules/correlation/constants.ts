/**
 * 聚合层常量 —— 第 4.1 节打分公式 + 第 4.2 节事件边界规则的唯一事实源。
 * 全部写死在这里而不是散落在函数里：调参只改一处，也方便验收时逐条对照文档。
 */

/** 打分公式权重（文档 4.1） */
export const WEIGHTS = {
  TOPOLOGY: 0.45,
  TIME: 0.3,
  TYPE: 0.25,
} as const;

/** 成簇阈值（文档 4.1） */
export const CLUSTER_THRESHOLD = 0.55;

/** B2：两簇分差小于该值时直接合并，避免同一故障被拆成两个事件 */
export const SCORE_TIE_EPSILON = 0.05;

/** 簇内告警数下限，低于此值不成事件（防噪声） */
export const MIN_ALERTS_PER_INCIDENT = 3;

/** 5 分钟滑窗：簇内任意两条告警的时间差硬上限 */
export const CLUSTER_WINDOW_MS = 5 * 60 * 1000;

/** B5 跨窗口：沿用一个未结事件时，只回看它最近 2 小时内的告警 */
export const FOLLOWUP_LOOKBACK_MS = 2 * 60 * 60 * 1000;

/**
 * B5 延续窗口：同一设备簇的告警在事件最近上报后 30 分钟内再现，直接沿用该事件。
 *
 * 为什么不能只靠打分：scorePair 的时间项以 firstSeen 为锚，静默 6 分钟就超过 5 分钟窗，
 * 时间项归零后拓扑 0.225 + 类型 0.175 = 0.40 < 0.55，同一场故障会被拆成两个事件。
 * 30 分钟与告警周期（AC-13/14）对齐，超过它才认为是"又一次发生"。
 */
export const CONTINUATION_WINDOW_MS = 30 * 60 * 1000;

/** B6 结案后重开窗口 */
export const REOPEN_WINDOW_MS = 30 * 60 * 1000;

/** 拓扑邻接最大跳数（B7 超过则不合并） */
export const MAX_HOPS = 2;

/** 拓扑接近度（文档 4.1） */
export const TOPOLOGY_PROXIMITY = {
  SAME_DEVICE: 1,
  DIRECT: 0.8,
  TWO_HOPS: 0.5,
  NONE: 0,
} as const;

/** B3 合并条件：共享设备数下限 */
export const MERGE_MIN_SHARED_DEVICES = 2;

/** B3 合并条件：时间重叠比例下限（Jaccard：交集 / 并集） */
export const MERGE_OVERLAP_RATIO = 0.5;

/** 事件处于这些状态时仍可被新告警沿用（B5） */
export const ACTIVE_INCIDENT_STATUSES = ['OPEN', 'ANALYZING', 'LOCATED', 'MITIGATED'] as const;

/** 事件已结案的状态（B6 判定起点） */
export const CLOSED_INCIDENT_STATUSES = ['RESOLVED', 'CLOSED'] as const;

/** 用于跳数计算的哨兵值：超过 MAX_HOPS 一律视为不可达 */
export const UNREACHABLE_HOPS = 99;
