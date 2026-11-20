/**
 * 真实数据源的字段归一化 —— Prometheus / Zabbix 的告警名到平台告警类型的映射。
 *
 * 为什么需要这一层：平台的抑制规则、打分权重、RCA 类型偏好都建立在
 * `LINK_DOWN / PACKET_LOSS / CPU_HIGH` 这套类型词表上（`alerts/taxonomy.ts`）。
 * 真实数据源给来的是 `NodeExporterDown`、`Interface GigabitEthernet0/1: Link down`
 * 这类自由文本，不归一化就全部落进 UNKNOWN —— 抑制不敢做（保守放行），
 * 打分里的"类型一致"永远拿不到分。
 *
 * 归一化策略是**只认明确信号**：命中不了就保留原始名的规范化形式（大写、空格转下划线），
 * 而不是硬塞一个 OTHER。原因是 OTHER 会让所有未知告警共享同一个指纹维度，
 * 反而把无关告警归成一组；保留原名至少能让"同一个未知告警"继续累加计数。
 */

const MAX_TYPE_LEN = 48;

/** 顺序有意义：先匹配具体故障，再落到"链路 Down"这类宽泛规则 */
const RULES: ReadonlyArray<readonly [RegExp, string]> = [
  // 硬件 / 环境
  [/optical|光模块|rx\s*power|tx\s*power|光功率/i, 'OPTICAL_RX_LOW'],
  [/fan|风扇/i, 'FAN_FAILURE'],
  [/power\s*supply|psu|电源/i, 'POWER_SUPPLY_FAILURE'],
  [/temperature|temp\b|温度/i, 'TEMPERATURE_HIGH'],
  [/voltage|电压/i, 'VOLTAGE_ABNORMAL'],
  [/line\s*card|linecard|板卡/i, 'LINECARD_FAILURE'],
  // 路由协议
  [/bgp/i, 'BGP_NEIGHBOR_DOWN'],
  [/ospf/i, 'OSPF_NEIGHBOR_DOWN'],
  // 链路质量
  [/crc|输入错误|input\s*error/i, 'CRC_ERROR'],
  [/flap|震荡|抖动.*恢复/i, 'PORT_FLAP'],
  [/packet\s*loss|丢包|loss\s*rate/i, 'PACKET_LOSS'],
  [/jitter|抖动/i, 'JITTER_HIGH'],
  [/latency|rtt|delay|时延|延迟/i, 'HIGH_LATENCY'],
  [/dns/i, 'DNS_TIMEOUT'],
  // 资源
  [/cpu/i, 'CPU_HIGH'],
  [/memory|内存|mem\b/i, 'MEMORY_HIGH'],
  [/disk|filesystem|磁盘|空间不足/i, 'DISK_HIGH'],
  [/session|conntrack|会话/i, 'SESSION_HIGH'],
  // 设备整体（放在端口/链路之前会误吞"BGP peer down"之类，故靠后）
  [/unreachable|不可达|device\s*down|host\s*down|node\s*down|offline|失联/i, 'DEVICE_UNREACHABLE'],
  [/link\s*down|链路.*down|链路.*断/i, 'LINK_DOWN'],
  [/port\s*down|interface.*down|端口.*down|端口.*断/i, 'PORT_DOWN'],
];

function normalizeRaw(name: string): string {
  return name
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9\u4e00-\u9fa5]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, MAX_TYPE_LEN);
}

/**
 * 告警标题 → 平台告警类型。
 * 无法识别时返回规范化后的原标题（而不是 OTHER，理由见文件头）。
 */
export function classifyAlertName(name: string): string {
  const text = name ?? '';
  for (const [pattern, type] of RULES) {
    if (pattern.test(text)) return type;
  }
  const normalized = normalizeRaw(text);
  return normalized.length > 0 ? normalized : 'OTHER';
}

/**
 * 从 `instance` 里剥掉端口：`10.1.0.1:9100` → `10.1.0.1`，`[fd00::1]:9100` → `[fd00::1]`。
 * node_exporter 一类的 instance 永远带端口，不剥掉就永远匹配不到设备。
 */
export function stripPort(instance: string): string {
  const value = instance.trim();
  const ipv6 = /^(\[[^\]]+\]):\d+$/.exec(value);
  if (ipv6) return ipv6[1]!;
  const withPort = /^([^:]+):(\d+)$/.exec(value);
  if (withPort) return withPort[1]!;
  return value;
}

/** 设备名候选：Prometheus 的常见标签按可靠性排序 */
export function pickInstanceLabel(labels: Record<string, string>): string | null {
  const keys = ['instance', 'host', 'hostname', 'node', 'device', 'target', 'job'];
  for (const key of keys) {
    const value = labels[key];
    if (value && value.trim().length > 0) return stripPort(value);
  }
  return null;
}

/** 从 annotations 里捞一个有限的数值：真实告警常把 value 写在注释里 */
export function numberFromAnnotations(
  annotations: Record<string, string>,
  keys: string[],
): number | undefined {
  for (const key of keys) {
    const raw = annotations[key];
    if (!raw) continue;
    const match = /-?\d+(?:\.\d+)?/.exec(raw);
    if (match) {
      const value = Number(match[0]);
      if (Number.isFinite(value)) return value;
    }
  }
  return undefined;
}
