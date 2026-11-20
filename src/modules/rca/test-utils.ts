import { buildDeviceGraph } from '@/modules/correlation/topology';
import { assessTopology } from '@/modules/topology/completeness';
import type { ContextBundle } from './context';

/**
 * 测试夹具：一棵 5 节点的树，专门用来区分"2 跳内"与"3 跳外"。
 *
 *   CORE-SW-01 ─┬─ AGG-SW-02 ── ACC-SW-07   （事件影响面：AGG-02 + ACC-07）
 *               └─ AGG-SW-03 ── ACC-SW-11
 *
 * ACC-07 → ACC-11 的距离是 4 跳，中间隔着 CORE，正好验证 L2 的剔除分支。
 * 生产代码不 import 本文件，只在测试里用。
 */

export const T0 = new Date('2026-11-19T02:00:00Z');
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000).toISOString();

const DEV = {
  core: { id: 'dev-core', name: 'CORE-SW-01', type: 'SWITCH', layer: 1, site: '园区A' },
  agg2: { id: 'dev-agg2', name: 'AGG-SW-02', type: 'SWITCH', layer: 2, site: '园区A' },
  agg3: { id: 'dev-agg3', name: 'AGG-SW-03', type: 'SWITCH', layer: 2, site: '园区B' },
  acc7: { id: 'dev-acc7', name: 'ACC-SW-07', type: 'SWITCH', layer: 3, site: '园区A' },
  acc11: { id: 'dev-acc11', name: 'ACC-SW-11', type: 'SWITCH', layer: 3, site: '园区B' },
} as const;

const LINKS = [
  { id: 'link-core-agg2', sourceId: DEV.core.id, targetId: DEV.agg2.id },
  { id: 'link-agg2-acc7', sourceId: DEV.agg2.id, targetId: DEV.acc7.id },
  { id: 'link-core-agg3', sourceId: DEV.core.id, targetId: DEV.agg3.id },
  { id: 'link-agg3-acc11', sourceId: DEV.agg3.id, targetId: DEV.acc11.id },
];

export function makeContext(): ContextBundle {
  const graph = buildDeviceGraph(LINKS);

  return {
    incident: {
      id: 'inc-1',
      code: 'INC-20261119-001',
      title: 'AGG-SW-02 整机不可达',
      severity: 'P0',
      status: 'OPEN',
      startedAt: at(0),
      lastSeen: at(12),
      firstAlertAt: at(0),
      deviceCount: 2,
      alertCount: 3,
      suppressedCount: 1,
    },
    nodes: [DEV.agg2, DEV.acc7],
    links: [
      {
        id: 'link-core-agg2',
        sourceId: DEV.core.id,
        targetId: DEV.agg2.id,
        sourceName: DEV.core.name,
        targetName: DEV.agg2.name,
        status: 'UP',
        hopsToIncident: 0,
      },
      {
        id: 'link-agg2-acc7',
        sourceId: DEV.agg2.id,
        targetId: DEV.acc7.id,
        sourceName: DEV.agg2.name,
        targetName: DEV.acc7.name,
        status: 'DOWN',
        hopsToIncident: 0,
      },
      {
        id: 'link-core-agg3',
        sourceId: DEV.core.id,
        targetId: DEV.agg3.id,
        sourceName: DEV.core.name,
        targetName: DEV.agg3.name,
        status: 'UP',
        hopsToIncident: 1,
      },
      {
        id: 'link-agg3-acc11',
        sourceId: DEV.agg3.id,
        targetId: DEV.acc11.id,
        sourceName: DEV.agg3.name,
        targetName: DEV.acc11.name,
        status: 'UP',
        hopsToIncident: 2,
      },
    ],
    alerts: [
      {
        id: 'alert-linecard',
        deviceId: DEV.agg2.id,
        deviceName: DEV.agg2.name,
        deviceLayer: 2,
        type: 'LINECARD_FAILURE',
        typeLabel: '线卡故障',
        alertClass: 'ROOT',
        metric: null,
        severity: 'P0',
        status: 'ACTIVE',
        count: 2,
        value: null,
        threshold: null,
        firstSeen: at(0),
        lastSeen: at(6),
        message: 'AGG-SW-02 线卡 3 故障',
        suppressed: false,
      },
      {
        id: 'alert-unreachable',
        deviceId: DEV.agg2.id,
        deviceName: DEV.agg2.name,
        deviceLayer: 2,
        type: 'DEVICE_UNREACHABLE',
        typeLabel: '设备不可达',
        alertClass: 'PARENT',
        metric: null,
        severity: 'P0',
        status: 'ACTIVE',
        count: 1,
        value: null,
        threshold: null,
        firstSeen: at(7),
        lastSeen: at(12),
        message: 'AGG-SW-02 不可达',
        suppressed: false,
      },
      {
        id: 'alert-link-down',
        deviceId: DEV.acc7.id,
        deviceName: DEV.acc7.name,
        deviceLayer: 3,
        type: 'LINK_DOWN',
        typeLabel: '链路 Down',
        alertClass: 'CHILD',
        metric: null,
        severity: 'P1',
        status: 'SUPPRESSED',
        count: 1,
        value: null,
        threshold: null,
        firstSeen: at(1),
        lastSeen: at(12),
        message: 'ACC-SW-07 上联 Down',
        suppressed: true,
      },
      {
        id: 'alert-far-loss',
        deviceId: DEV.acc11.id,
        deviceName: DEV.acc11.name,
        deviceLayer: 3,
        type: 'PACKET_LOSS',
        typeLabel: '丢包',
        alertClass: 'CHILD',
        metric: 'packet_loss',
        severity: 'P2',
        status: 'ACTIVE',
        count: 1,
        value: 3.2,
        threshold: 1,
        firstSeen: at(4),
        lastSeen: at(4),
        message: 'ACC-SW-11 丢包 3.2%',
        suppressed: false,
      },
    ],
    metrics: [
      {
        ref: `metric:${DEV.acc11.name}:packet_loss`,
        deviceId: DEV.acc11.id,
        deviceName: DEV.acc11.name,
        metric: 'packet_loss',
        value: 3.2,
        threshold: 1,
        unit: '%',
        at: at(4),
        source: 'ALERT' as const,
      },
    ],
    changes: [
      {
        id: 'change-core',
        deviceId: DEV.core.id,
        deviceName: DEV.core.name,
        kind: 'CONFIG',
        content: '核心交换机 ACL 策略下发',
        operator: '张工',
        changedAt: at(-20),
        beforeFirstAlert: true,
      },
      {
        id: 'change-late',
        deviceId: DEV.agg2.id,
        deviceName: DEV.agg2.name,
        kind: 'CONFIG',
        content: '事件开始后补录的变更',
        operator: '李工',
        changedAt: at(9),
        beforeFirstAlert: false,
      },
      {
        id: 'change-far',
        deviceId: DEV.acc11.id,
        deviceName: DEV.acc11.name,
        kind: 'FIRMWARE',
        content: '园区B 接入交换机升级',
        operator: '王工',
        changedAt: at(-30),
        beforeFirstAlert: true,
      },
    ],
    cases: [
      {
        id: 'case-power',
        title: '汇聚交换机电源模块故障导致整机重启',
        symptom: 'AGG-SW-02 整机离线',
        rootCause: '电源模块老化',
        resolution: '更换电源模块',
        tags: ['硬件', '电源', '设备离线'],
        relevant: true,
      },
      {
        id: 'case-cloud',
        title: '云上业务间歇性 5xx',
        symptom: '云平台接口返回 5xx，网络侧无异常',
        rootCause: '应用侧连接池耗尽',
        resolution: '扩容应用连接池',
        tags: ['云平台', 'API', '5xx'],
        relevant: false,
      },
    ],
    graph,
    topology: assessTopology([DEV.agg2, DEV.acc7], LINKS),
    trim: { trimmed: [], chars: 0 },
  };
}

export const DEVICE_IDS = DEV;
