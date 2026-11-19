import { deviceLayerLabel } from '@/modules/alerts/labels';
import type { ContextBundle } from './context';

/**
 * Prompt 组装（文档 10.1 的上下文骨架）。
 *
 * 两条硬要求写进 system，不靠"请勿幻觉"这种软话：
 *   1. evidence.ref 只能填下面清单里出现过的 ID —— 校验器会逐条核对，编的会被整条丢弃；
 *   2. 没有证据支撑就不要输出该假设 —— 宁可少一条，不可给一条无依据的。
 * 这不是为了"礼貌"，而是让模型的输出结构与校验器的判定口径完全对齐。
 */

export const PROMPT_VERSION = 'rca-1.0';

export const SYSTEM_PROMPT = `你是资深网络运维专家，负责根据告警、拓扑、变更与历史案例定位故障根因。

硬性规则：
1. evidence.ref 只能填写下方清单中出现过的 ID（告警/变更/链路/案例），不得编造，不得使用设备名代替 ID。
2. 每条假设至少引用 1 条真实证据；没有证据支撑的猜测不要输出。
3. 最多输出 3 条假设，按可能性从高到低排列，confidence 取 0~1。
4. 因果方向：下游设备告警不能推导出上游故障；晚于首个告警的变更不能作为原因。
5. 只输出 JSON 对象，不要 markdown 代码围栏，不要解释文字。

JSON 结构（字段名与枚举值必须完全一致）：
{
  "summary": "一句话结论，<=200字",
  "impactScope": "影响面描述，<=200字",
  "severity": "P0|P1|P2|P3",
  "hypotheses": [
    {
      "cause": "根因描述，4~120字",
      "category": "HARDWARE|CONFIG|LINK|CAPACITY|UPSTREAM|OTHER",
      "confidence": 0.0,
      "evidence": [{ "type": "ALERT|CHANGE|TOPOLOGY|CASE", "ref": "真实ID", "desc": "<=160字" }],
      "verifySteps": ["现场验证动作，1~5条"],
      "actions": [{ "action": "处置动作", "risk": "LOW|MEDIUM|HIGH", "requiresApproval": true }]
    }
  ],
  "missingInfo": ["还缺哪些信息才能定论，0~5条"]
}`;

export type PromptPayload = { system: string; user: string };

/** 把上下文文本化。顺序固定，便于 diff 两次研判的输入差异 */
export function renderPrompt(ctx: ContextBundle): PromptPayload {
  const lines: string[] = [];
  const push = (line = '') => lines.push(line);

  push('[事件]');
  push(
    `${ctx.incident.code} | ${ctx.incident.title} | 严重度 ${ctx.incident.severity} | 状态 ${ctx.incident.status}`,
  );
  push(
    `开始 ${ctx.incident.startedAt}，最近一次告警 ${ctx.incident.lastSeen}，首个告警 ${ctx.incident.firstAlertAt}`,
  );
  push(
    `涉及 ${ctx.incident.deviceCount} 台设备 / ${ctx.incident.alertCount} 条告警（其中被抑制 ${ctx.incident.suppressedCount} 条）`,
  );

  push();
  push('[告警]（按严重度排序，id 可直接作为 evidence.ref）');
  for (const a of ctx.alerts) {
    const metric = a.metric
      ? ` ${a.metric}=${a.value ?? '-'}${a.threshold !== null ? `/阈值${a.threshold}` : ''}`
      : '';
    const count = a.count > 1 ? ` ×${a.count}` : '';
    push(
      `- ${a.id} | ${a.deviceName}(${deviceLayerLabel(a.deviceLayer)}) | ${a.type}/${a.typeLabel} | ${a.severity} | ${a.status}${a.suppressed ? '(已抑制)' : ''} |${metric} | 首次 ${a.firstSeen} | 末次 ${a.lastSeen}${count}`,
    );
  }

  if (ctx.links.length > 0) {
    push();
    push('[拓扑]（无向邻接，链路 id 可作 evidence.ref，type 填 TOPOLOGY）');
    for (const l of ctx.links) {
      push(
        `- ${l.id} | ${l.sourceName} <-> ${l.targetName} | ${l.status} | 距影响面 ${l.hopsToIncident} 跳`,
      );
    }
    push(
      `影响面设备：${ctx.nodes.map((n) => `${n.name}(${deviceLayerLabel(n.layer)})`).join('、')}`,
    );
  }

  if (ctx.metrics.length > 0) {
    push();
    push('[指标]（仅告警上报时刻的快照，无时间序列，不要当趋势使用）');
    for (const m of ctx.metrics) {
      push(
        `- ${m.deviceName} ${m.metric} = ${m.value ?? '未知'}${m.threshold !== null ? `（阈值 ${m.threshold}）` : ''} @ ${m.at}`,
      );
    }
  }

  if (ctx.changes.length > 0) {
    push();
    push('[变更]（只有早于首个告警的变更才可能是原因，id 可作 evidence.ref，type 填 CHANGE）');
    for (const c of ctx.changes) {
      push(
        `- ${c.id} | ${c.deviceName} | ${c.kind} | ${c.content} | 操作人 ${c.operator ?? '未知'} | ${c.changedAt}${c.beforeFirstAlert ? '' : ' | 晚于首个告警，不可作为原因'}`,
      );
    }
  }

  if (ctx.cases.length > 0) {
    push();
    push('[历史案例]（tags 与本次告警类型相关，id 可作 evidence.ref，type 填 CASE）');
    for (const c of ctx.cases) {
      push(`- ${c.id} | ${c.title} | 现象：${c.symptom}`);
      push(`  根因：${c.rootCause}`);
      push(`  处置：${c.resolution} | tags：${c.tags.join('/')}`);
    }
  }

  if (ctx.trim.trimmed.length > 0) {
    push();
    push(`[注] 本上下文因长度限制已裁剪：${ctx.trim.trimmed.join('、')}`);
  }

  push();
  push('[输出] 按要求输出 JSON 对象。');

  return { system: SYSTEM_PROMPT, user: lines.join('\n') };
}
