import { classifyAlertType } from '@/modules/alerts/taxonomy';
import { familyOf } from '@/modules/correlation/affinity';

/**
 * 证据相关性判定（文档 10.3 的 L2）—— 只回答"这条证据跟这次事件有没有关系"，
 * 不回答"根因判断对不对"。后者没有捷径，只能靠评测集与人工接受率（README 里会写清楚）。
 *
 * 单独成文件的原因：规则 fallback 也要用同一套判定来挑证据，若两边各写一份，
 * 校验器与 fallback 的口径迟早会漂移，最后变成"自己给自己放水"。
 */

/** L2 允许的最大拓扑距离（与聚合层 MAX_HOPS 同值，但语义不同：这里判相关性，那里判能否合并） */
export const RELEVANCE_MAX_HOPS = 2;

/** 变更与首个告警的间隔小于该值时，L3 视为"太巧合"降权 */
export const SUSPICIOUS_CHANGE_GAP_MS = 60 * 1000;

/**
 * 告警类型族 → 案例 tag 关键词。
 * 案例 tags 是中文短语（seed 里是"电源""光模块""丢包"这类），与英文告警类型没有字面交集，
 * 必须先归族再映射，否则 L2 的 CASE 分支永远判"不相关"，把历史案例全丢掉。
 */
const CASE_TAG_HINTS: Record<string, readonly string[]> = {
  DEVICE: ['设备', '离线', '宕机', '断电', '电源', '硬件', '机框', '主控', '板卡', '线卡', '重启'],
  LINK: ['链路', '端口', '光模块', '光衰', '光功率', '光纤', '闪断', '线缆', '收发'],
  ROUTING: ['路由', '邻居', 'BGP', 'OSPF', 'ACL', '策略', '网关'],
  QUALITY: ['丢包', '时延', '抖动', 'DNS', '解析', '重传'],
  RESOURCE: ['CPU', '内存', '会话', '容量', '带宽', '负载', '风扇', '温度'],
  OTHER: [],
};

/** 事件告警类型集合 → 可用于匹配案例 tag 的关键词集合 */
export function caseTagHints(alertTypes: Iterable<string>): Set<string> {
  const hints = new Set<string>();
  for (const type of alertTypes) {
    const cls = classifyAlertType(type);
    // 硬件类先按族走，DEVICE 族关键词已覆盖"电源/线卡/风扇"
    const family = cls === 'ROOT' ? 'DEVICE' : familyOf(type);
    for (const word of CASE_TAG_HINTS[family] ?? []) hints.add(word);
  }
  return hints;
}

/** 案例 tags 与事件告警类型是否有交集（子串命中，因为 tag 多为"设备离线"这类复合词） */
export function isCaseRelevant(tags: readonly string[], alertTypes: Iterable<string>): boolean {
  const hints = caseTagHints(alertTypes);
  if (hints.size === 0 || tags.length === 0) return false;
  return tags.some((tag) => {
    const normalized = tag.trim();
    if (normalized.length === 0) return false;
    for (const hint of hints) {
      if (normalized === hint || normalized.includes(hint) || hint.includes(normalized)) {
        return true;
      }
    }
    return false;
  });
}

/** 该设备是否在事件影响面内，或与影响面拓扑距离 ≤ 2 跳 */
export function isDeviceRelated(
  deviceId: string,
  incidentDeviceIds: ReadonlySet<string>,
  hop: (a: string, b: string) => number,
): boolean {
  if (incidentDeviceIds.has(deviceId)) return true;
  for (const id of incidentDeviceIds) {
    if (hop(id, deviceId) <= RELEVANCE_MAX_HOPS) return true;
  }
  return false;
}
