/**
 * 告警类型的中文短标签。
 *
 * 只做展示，不参与任何规则判断（规则见 `taxonomy.ts`）。
 * 未登记的类型直接回落为原始英文，宁可难看也不要猜错语义。
 */
const ALERT_TYPE_LABELS: Record<string, string> = {
  // 设备级
  DEVICE_UNREACHABLE: '设备不可达',
  DEVICE_DOWN: '设备宕机',
  DEVICE_OFFLINE: '设备离线',
  DEVICE_POWER_FAILURE: '设备断电',
  AGENT_UNREACHABLE: '采集 Agent 失联',
  LINECARD_FAILURE: '线卡故障',
  CHASSIS_FAILURE: '机框故障',
  SUPERVISOR_FAILURE: '主控故障',
  FAN_FAILURE: '风扇故障',
  POWER_SUPPLY_FAILURE: '电源故障',
  MEMORY_FAILURE: '内存故障',
  DISK_FAILURE: '磁盘故障',
  TEMPERATURE_HIGH: '温度过高',
  VOLTAGE_ABNORMAL: '电压异常',
  // 端口与链路
  LINK_DOWN: '链路 Down',
  PORT_DOWN: '端口 Down',
  PORT_FLAP: '端口震荡',
  INTERFACE_ERROR: '接口错误',
  CRC_ERROR: 'CRC 错误',
  OPTICAL_RX_LOW: '光模块收光低',
  OPTICAL_TX_LOW: '光模块发光低',
  OPTICAL_MODULE_FAILURE: '光模块故障',
  // 邻居与路由
  BGP_NEIGHBOR_DOWN: 'BGP 邻居 Down',
  OSPF_NEIGHBOR_DOWN: 'OSPF 邻居 Down',
  ACL_DENY_HIT: 'ACL 命中丢弃',
  ROUTE_FLAP: '路由震荡',
  // 质量指标
  PACKET_LOSS: '丢包',
  HIGH_LATENCY: '高时延',
  JITTER_HIGH: '抖动',
  DNS_TIMEOUT: 'DNS 超时',
  // 资源指标
  CPU_HIGH: 'CPU 使用率高',
  MEMORY_HIGH: '内存使用率高',
  SESSION_HIGH: '会话数高',
};

export function alertTypeLabel(type: string): string {
  const key = type.trim().toUpperCase();
  return ALERT_TYPE_LABELS[key] ?? key;
}

/** 事件标题里常带设备名，太长的截断留给 UI，这里只做文本归一 */
export function deviceLayerLabel(layer: number): string {
  if (layer <= 1) return '核心层';
  if (layer === 2) return '汇聚层';
  return '接入层';
}
