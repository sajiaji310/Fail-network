/**
 * 告警类型分类 —— 抑制规则的唯一事实源（第 4.1 节「步 2 抑制」）。
 *
 * 为什么不按"父告警抑制同设备全部告警"实现：
 * `core-switch-board-failure` 剧本里 CORE-SW-01 的根因告警是 `LINECARD_FAILURE`（第 0 分钟），
 * 父告警 `DEVICE_UNREACHABLE` 在第 7 分钟才到。若同设备全抑制，根因必被误杀，
 * AC-19「标注根因的告警误抑制率 = 0」直接不达标。
 *
 * 因此采用**可抑制白名单**：只有明确属于"取决于设备可达性"的端口/链路/邻居/指标类告警才会被压制；
 * 未登记的类型一律不抑制（宁可留噪声，不可丢根因）。
 */

/** 父告警：设备整体不可用，是其它推断性告警的成因 */
export const PARENT_ALERT_TYPES: ReadonlySet<string> = new Set([
  'DEVICE_UNREACHABLE',
  'DEVICE_DOWN',
  'DEVICE_OFFLINE',
  'DEVICE_POWER_FAILURE',
  'AGENT_UNREACHABLE',
]);

/** 设备级根因告警：不抑制。它们本身是排障起点，与父告警同级甚至更靠前 */
export const ROOT_LEVEL_ALERT_TYPES: ReadonlySet<string> = new Set([
  'LINECARD_FAILURE',
  'CHASSIS_FAILURE',
  'SUPERVISOR_FAILURE',
  'FAN_FAILURE',
  'POWER_SUPPLY_FAILURE',
  'MEMORY_FAILURE',
  'DISK_FAILURE',
  'TEMPERATURE_HIGH',
  'VOLTAGE_ABNORMAL',
]);

/**
 * 可被父告警抑制的类型：设备不可达时，这些数据**本身不可信**
 * （采集断了自己就报端口 Down / 邻居 Down / 丢包 / CPU 高）。
 */
export const SUPPRESSIBLE_ALERT_TYPES: ReadonlySet<string> = new Set([
  // 端口与链路
  'LINK_DOWN',
  'PORT_DOWN',
  'PORT_FLAP',
  'INTERFACE_ERROR',
  'CRC_ERROR',
  'OPTICAL_RX_LOW',
  'OPTICAL_TX_LOW',
  'OPTICAL_MODULE_FAILURE',
  // 邻居与路由
  'BGP_NEIGHBOR_DOWN',
  'OSPF_NEIGHBOR_DOWN',
  'ACL_DENY_HIT',
  // 质量指标
  'PACKET_LOSS',
  'HIGH_LATENCY',
  'JITTER_HIGH',
  'DNS_TIMEOUT',
  // 资源指标
  'CPU_HIGH',
  'MEMORY_HIGH',
  'SESSION_HIGH',
]);

export type AlertClass = 'PARENT' | 'ROOT' | 'CHILD' | 'UNKNOWN';

export function classifyAlertType(type: string): AlertClass {
  const t = type.trim().toUpperCase();
  if (PARENT_ALERT_TYPES.has(t)) return 'PARENT';
  if (ROOT_LEVEL_ALERT_TYPES.has(t)) return 'ROOT';
  if (SUPPRESSIBLE_ALERT_TYPES.has(t)) return 'CHILD';
  return 'UNKNOWN';
}

export function isParentAlertType(type: string): boolean {
  return classifyAlertType(type) === 'PARENT';
}

/** 只有 CHILD 类会被父告警压制；UNKNOWN 保守放行 */
export function isSuppressible(type: string): boolean {
  return classifyAlertType(type) === 'CHILD';
}

/** 设备不可达时，父告警本身也需要在恢复时被识别 */
export function isDeviceLevelAlert(type: string): boolean {
  const c = classifyAlertType(type);
  return c === 'PARENT' || c === 'ROOT';
}
