import { deviceLayerLabel } from '@/modules/alerts/labels';
import { classifyAlertType, type AlertClass } from '@/modules/alerts/taxonomy';
import { familyOf } from '@/modules/correlation/affinity';
import type { ContextBundle } from './context';
import type { HypothesisCategory } from './schema';

/**
 * 归因本体的单一事实来源（Spec 0.2 §3.1）。
 *
 * 为什么要把这三个判断从 `fallback.ts` 里抽出来：提示词要告诉模型"这个告警类型默认归哪一类"，
 * 规则引擎要按同一套约定给 category，指标准入要判断"这个类型算不算可解释"。
 * 三处各写一份，改一处忘两处，模型和规则从此对不上口径 —— 而它们的对话对象是同一个值班人。
 *
 * 抽出来以后 `fallback.ts` 只保留"打分/排序"，归因一律走这里；行为与抽取前逐字等值，
 * 由 `fallback.test.ts` 的老用例和 `explainability.test.ts` 的等值断言共同锁定。
 */

/**
 * 类型是否"可解释"：已登记进分类表或告警族表。
 *
 * 未登记的类型不是"可疑"，是"看不懂"——它不构成证据，也不构成拒答的反证（AC-20 靠它兜底）。
 */
export function isExplainedType(type: string): boolean {
  return classifyAlertType(type) !== 'UNKNOWN' || familyOf(type) !== 'OTHER';
}

/**
 * 类型的默认归类。返回 null 表示未登记（调用方自己决定是兜底成 OTHER 还是拒绝出结论）。
 *
 * 刻意与 `familyOf` 的六个族不完全同构：DNS 超时归在 QUALITY 族，但故障源几乎总在上游递归
 * 服务器，按族映射成 LINK 会把运维引向排查内网链路（dev-04/test-04 都是这么错的）。
 */
export function categoryOfType(type: string, alertClass: AlertClass): HypothesisCategory | null {
  if (alertClass === 'ROOT' || alertClass === 'PARENT') return 'HARDWARE';
  if (type.trim().toUpperCase() === 'DNS_TIMEOUT') return 'UPSTREAM';
  const family = familyOf(type);
  if (family === 'LINK') return 'LINK';
  if (family === 'ROUTING') return 'UPSTREAM';
  if (family === 'RESOURCE') return 'CAPACITY';
  if (family === 'QUALITY') return 'LINK';
  return null;
}

/**
 * 提示词里渲染的归因标签。未登记写"未登记"而不是猜一个类别：
 * 让模型看到"这里没有先验"，比给它一个错误的先验更安全。
 */
export function attributionTag(type: string, alertClass: AlertClass): string {
  return categoryOfType(type, alertClass) ?? '未登记';
}

/**
 * 设备信号（Spec §3.1 / §4.5 的 B 组消融实验专用）。
 *
 * 只陈述事实：哪台设备报了多少条、什么类型、有没有事件前变更。**不含分数、不含排序**——
 * 一旦带上规则引擎的排名，B 组就变成"把答案抄进提示词"，测出来的是泄露程度而不是信号价值。
 * 默认关闭（`RCA_SIGNALS=off`），仅在 dev 集上做消融。
 */
export type DeviceSignal = {
  deviceName: string;
  /** 层级标签；只有事件告警设备才知道层级，纯变更设备可能为 null（不猜） */
  layerLabel: string | null;
  alertCount: number;
  types: string[];
  hasPrecedingChange: boolean;
};

export function buildDeviceSignals(ctx: ContextBundle): DeviceSignal[] {
  const byDevice = new Map<string, { name: string; layer: number | null; types: string[] }>();
  const touch = (deviceId: string, name: string, layer: number | null) => {
    const entry = byDevice.get(deviceId) ?? { name, layer, types: [] };
    if (entry.layer === null) entry.layer = layer;
    byDevice.set(deviceId, entry);
    return entry;
  };

  for (const alert of ctx.alerts) {
    touch(alert.deviceId, alert.deviceName, alert.deviceLayer).types.push(alert.type);
  }
  // 有事件前变更但自己没告警的设备也要列出来：ACL 类故障的根因设备通常一条告警都没有，
  // 只按告警建设备集合会把最有价值的那个信号漏掉
  for (const change of ctx.changes) {
    if (!change.beforeFirstAlert) continue;
    const layer = ctx.nodes.find((n) => n.id === change.deviceId)?.layer ?? null;
    touch(change.deviceId, change.deviceName, layer);
  }

  const changedDevices = new Set(
    ctx.changes.filter((c) => c.beforeFirstAlert).map((c) => c.deviceId),
  );

  return [...byDevice.entries()].map(([deviceId, entry]) => ({
    deviceName: entry.name,
    layerLabel: entry.layer === null ? null : deviceLayerLabel(entry.layer),
    alertCount: entry.types.length,
    types: [...new Set(entry.types)],
    hasPrecedingChange: changedDevices.has(deviceId),
  }));
}
