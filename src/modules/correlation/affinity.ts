/**
 * 告警类型共现矩阵（文档 4.1 的 `typeAffinity`）。
 *
 * 做法：先把类型归到 6 个族，再用族间亲和度查表。
 * 不用"两两类型"的 20×20 矩阵，是因为新增一个告警类型就得填 40 个格子，
 * 实际维护中必然会偷懒填 1 —— 按族归类后新增类型只需归一次族。
 */

export type AlertFamily = 'DEVICE' | 'LINK' | 'ROUTING' | 'QUALITY' | 'RESOURCE' | 'OTHER';

const FAMILY_OF_TYPE: Record<string, AlertFamily> = {
  // 设备整体 / 硬件
  DEVICE_UNREACHABLE: 'DEVICE',
  DEVICE_DOWN: 'DEVICE',
  DEVICE_OFFLINE: 'DEVICE',
  DEVICE_POWER_FAILURE: 'DEVICE',
  AGENT_UNREACHABLE: 'DEVICE',
  LINECARD_FAILURE: 'DEVICE',
  CHASSIS_FAILURE: 'DEVICE',
  SUPERVISOR_FAILURE: 'DEVICE',
  FAN_FAILURE: 'DEVICE',
  POWER_SUPPLY_FAILURE: 'DEVICE',
  MEMORY_FAILURE: 'DEVICE',
  DISK_FAILURE: 'DEVICE',
  TEMPERATURE_HIGH: 'DEVICE',
  VOLTAGE_ABNORMAL: 'DEVICE',

  // 端口 / 链路 / 光层
  LINK_DOWN: 'LINK',
  PORT_DOWN: 'LINK',
  PORT_FLAP: 'LINK',
  INTERFACE_ERROR: 'LINK',
  CRC_ERROR: 'LINK',
  OPTICAL_RX_LOW: 'LINK',
  OPTICAL_TX_LOW: 'LINK',
  OPTICAL_MODULE_FAILURE: 'LINK',

  // 邻居 / 路由策略
  BGP_NEIGHBOR_DOWN: 'ROUTING',
  OSPF_NEIGHBOR_DOWN: 'ROUTING',
  ROUTE_FLAP: 'ROUTING',
  ACL_DENY_HIT: 'ROUTING',

  // 质量指标
  PACKET_LOSS: 'QUALITY',
  HIGH_LATENCY: 'QUALITY',
  JITTER_HIGH: 'QUALITY',
  DNS_TIMEOUT: 'QUALITY',

  // 资源指标
  CPU_HIGH: 'RESOURCE',
  MEMORY_HIGH: 'RESOURCE',
  SESSION_HIGH: 'RESOURCE',
};

/** 族间亲和度（对称）。未列出的组合走 DEFAULT_AFFINITY */
const FAMILY_AFFINITY: Record<AlertFamily, Partial<Record<AlertFamily, number>>> = {
  DEVICE: { DEVICE: 0.9, LINK: 0.7, ROUTING: 0.6, QUALITY: 0.6, RESOURCE: 0.5 },
  LINK: { DEVICE: 0.7, LINK: 0.9, ROUTING: 0.6, QUALITY: 0.7, RESOURCE: 0.3 },
  ROUTING: { DEVICE: 0.6, LINK: 0.6, ROUTING: 0.8, QUALITY: 0.6, RESOURCE: 0.3 },
  QUALITY: { DEVICE: 0.6, LINK: 0.7, ROUTING: 0.6, QUALITY: 0.8, RESOURCE: 0.4 },
  RESOURCE: { DEVICE: 0.5, LINK: 0.3, ROUTING: 0.3, QUALITY: 0.4, RESOURCE: 0.8 },
  OTHER: {},
};

const DEFAULT_AFFINITY = 0.3;

export function familyOf(type: string): AlertFamily {
  return FAMILY_OF_TYPE[type.trim().toUpperCase()] ?? 'OTHER';
}

/**
 * 类型亲和度：同类型 1.0，同族 0.8~0.9，跨族查表，未知 0.3。
 * 返回 0~1，直接乘权重 0.25。
 */
export function typeAffinity(typeA: string, typeB: string): number {
  const a = typeA.trim().toUpperCase();
  const b = typeB.trim().toUpperCase();
  if (a === b) return 1;
  const familyA = familyOf(a);
  const familyB = familyOf(b);
  return FAMILY_AFFINITY[familyA][familyB] ?? DEFAULT_AFFINITY;
}
