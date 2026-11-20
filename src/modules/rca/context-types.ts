import type { DeviceGraph } from '@/modules/correlation/topology';
import type { TopologyCoverage } from '@/modules/topology/completeness';
import type { Severity } from '@prisma/client';

/**
 * 研判上下文的形状（文档 10.1）。
 * 单独成文件：context.ts 要留出 300 行预算给取数逻辑，而 prompt / fallback / verify
 * 三个模块都要 import 这些类型，放在实现文件里会让依赖关系看起来比实际更重。
 */

export type ContextAlert = {
  id: string;
  deviceId: string;
  deviceName: string;
  deviceLayer: number;
  type: string;
  typeLabel: string;
  alertClass: 'PARENT' | 'ROOT' | 'CHILD' | 'UNKNOWN';
  metric: string | null;
  severity: Severity;
  status: string;
  count: number;
  value: number | null;
  threshold: number | null;
  firstSeen: string;
  lastSeen: string;
  message: string;
  suppressed: boolean;
};

export type ContextNode = {
  id: string;
  name: string;
  type: string;
  layer: number;
  site: string | null;
};

export type ContextLink = {
  id: string;
  sourceId: string;
  targetId: string;
  sourceName: string;
  targetName: string;
  status: string;
  /** 链路两端到事件影响面的最小跳数：0 两端都在影响面内，1 直连，2 两跳 */
  hopsToIncident: number;
};

export type ContextMetric = {
  /**
   * 证据引用：`metric:<设备名>:<指标>`。
   * 用可读的复合键而不是采样点 id：模型引用的是"这条曲线"，不是某个 5 秒采样。
   */
  ref: string;
  deviceId: string;
  deviceName: string;
  metric: string;
  value: number | null;
  threshold: number | null;
  /** 单位（% / ms / Mbps）；告警自带的瞬时值没有单位信息时为 null */
  unit: string | null;
  at: string;
  /** ALERT=告警自带的瞬时值；SAMPLE=指标快照（有 trend） */
  source: 'ALERT' | 'SAMPLE';
  /** 采样趋势：只有存在指标快照时才有，没有采样就不该让模型谈趋势 */
  trend?: {
    samples: number;
    first: number;
    last: number;
    min: number;
    max: number;
    slopePerMin: number;
    from: string;
    to: string;
  };
};

export type ContextChange = {
  id: string;
  deviceId: string;
  deviceName: string;
  kind: string;
  content: string;
  operator: string | null;
  changedAt: string;
  /** 是否早于事件首个告警：false 的变更不可能是原因（L2 硬条件） */
  beforeFirstAlert: boolean;
};

export type ContextCase = {
  id: string;
  title: string;
  symptom: string;
  rootCause: string;
  resolution: string;
  tags: string[];
  relevant: boolean;
};

export type ContextBundle = {
  incident: {
    id: string;
    code: string;
    title: string;
    severity: Severity;
    status: string;
    startedAt: string;
    lastSeen: string;
    firstAlertAt: string;
    deviceCount: number;
    alertCount: number;
    suppressedCount: number;
  };
  nodes: ContextNode[];
  links: ContextLink[];
  alerts: ContextAlert[];
  metrics: ContextMetric[];
  changes: ContextChange[];
  cases: ContextCase[];
  /** 拓扑完整度：缺拓扑时 prompt 与置信度都要降级（评审 P0-4） */
  topology: TopologyCoverage;
  /** 为校验器准备的旁路索引，不参与 prompt 渲染 */
  graph: DeviceGraph;
  trim: { trimmed: string[]; chars: number };
};
