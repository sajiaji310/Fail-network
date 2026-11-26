import { deviceLayerLabel } from '@/modules/alerts/labels';
import { rcaHintEnabled, rcaSignalsEnabled } from '@/lib/env';
import { TOPOLOGY_LEVEL_LABEL } from '@/modules/topology/completeness';
import type { ContextBundle } from './context';
import { attributionTag, buildDeviceSignals } from './explainability';

/**
 * Prompt 组装（文档 10.1 的上下文骨架 + Spec 0.2 §3.2/§3.5）。
 *
 * 两条硬要求写进 system，不靠"请勿幻觉"这种软话：
 *   1. evidence.ref 只能填下面清单里出现过的 ID —— 校验器会逐条核对，编的会被整条丢弃；
 *   2. 没有证据支撑就不要输出该假设 —— 宁可少一条，不可给一条无依据的。
 * 这不是为了"礼貌"，而是让模型的输出结构与校验器的判定口径完全对齐。
 *
 * 0.2 加了第二层：每条告警行尾带 `归因:X`（系统的默认归类）。它解决的是 F1 ——
 * 模型看得到 type 却不知道我们的分类约定，于是 PACKET_LOSS 归 HARDWARE 这类错误反复出现。
 * 归因只是**默认值**：与现场证据冲突时可以覆盖，但必须写明理由（SYSTEM_PROMPT 第 6 条）。
 */

export const PROMPT_VERSION = 'rca-1.1';

/** 指标趋势最多展开 3 条：再多的曲线对定因没有增量，只吃 token 和注意力 */
const MAX_TREND_LINES = 3;

export const SYSTEM_PROMPT = `你是资深网络运维专家，负责根据告警、拓扑、变更与历史案例定位故障根因。

硬性规则：
1. evidence.ref 只能填写下方清单中出现过的 ID（告警/变更/链路/案例/指标），不得编造，不得使用设备名代替 ID。
2. 每条假设至少引用 1 条真实证据；没有证据支撑的猜测不要输出。
3. 最多输出 3 条假设，按可能性从高到低排列，confidence 取 0~1。
4. 因果方向：下游设备告警不能推导出上游故障；晚于首个告警的变更不能作为原因。
5. 只输出 JSON 对象，不要 markdown 代码围栏，不要解释文字。
6. category 字段优先采用告警行尾的归因标签；若现场证据明确指向另一类，可以覆盖，但必须在 evidence.desc 中写明偏离理由。

输出体量（超出部分会被截断，导致整条结论作废）：
- evidence 最多 3 条，每条 desc 不超过 80 字；
- verifySteps 只写 1~2 条最关键的现场验证动作；
- actions 最多 1 条；
- hypotheses 最多 3 条。

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
      "evidence": [{ "type": "ALERT|CHANGE|TOPOLOGY|CASE|METRIC", "ref": "真实ID", "desc": "<=80字" }],
      "verifySteps": ["现场验证动作，1~2条"],
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
  push(
    `拓扑完整度：${TOPOLOGY_LEVEL_LABEL[ctx.topology.level]}（${ctx.topology.linkedDevices}/${ctx.topology.deviceCount} 台设备有链路记录，连通分量 ${ctx.topology.components}）`,
  );
  if (ctx.topology.level !== 'FULL') {
    push(
      `注意：拓扑不完整时不要把结论说成定论，confidence 不超过 ${ctx.topology.level === 'MISSING' ? 0.55 : 0.75}，并在 missingInfo 里写明缺了哪些设备的链路。`,
    );
  }

  push();
  const hintOn = rcaHintEnabled();
  push(
    hintOn
      ? '[告警]（按严重度排序，id 可直接作为 evidence.ref；行尾「归因」是告警类型的默认归类，只用于填 category 字段，不指示根因在哪台设备；与现场证据冲突时以证据为准，并在 evidence.desc 写明偏离理由）'
      : '[告警]（按严重度排序，id 可直接作为 evidence.ref）',
  );
  for (const a of ctx.alerts) {
    const metric = a.metric
      ? ` ${a.metric}=${a.value ?? '-'}${a.threshold !== null ? `/阈值${a.threshold}` : ''}`
      : '';
    const count = a.count > 1 ? ` ×${a.count}` : '';
    const tag = hintOn ? ` | 归因:${attributionTag(a.type, a.alertClass)}` : '';
    push(
      `- ${a.id} | ${a.deviceName}(${deviceLayerLabel(a.deviceLayer)}) | ${a.type}/${a.typeLabel} | ${a.severity} | ${a.status}${a.suppressed ? '(已抑制)' : ''} |${metric} | 首次 ${a.firstSeen} | 末次 ${a.lastSeen}${count}${tag}`,
    );
  }

  if (rcaSignalsEnabled()) {
    const signals = buildDeviceSignals(ctx);
    if (signals.length > 0) {
      push();
      push(
        '[设备信号]（事实统计：每台设备报了多少条、哪些类型、是否有事件前变更；不含评分与排序）',
      );
      for (const s of signals) {
        const layer = s.layerLabel ? ` | ${s.layerLabel}` : '';
        const types = s.types.length > 0 ? ` | 类型 ${s.types.join('/')}` : ' | 无告警';
        push(
          `- ${s.deviceName}${layer} | 告警 ${s.alertCount} 条${types} | ${s.hasPrecedingChange ? '事件前有变更' : '事件前无变更'}`,
        );
      }
    }
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
  } else {
    // 空白比沉默好：不写这一行，模型会以为"没有链路"等于"没有关联"
    push();
    push('[拓扑] 无任何链路数据可用：无法判断设备间上下游关系，只能依据时间与告警类型归因。');
  }

  if (ctx.metrics.length > 0) {
    push();
    const hasTrend = ctx.metrics.some((m) => m.trend);
    push(
      hasTrend
        ? '[指标]（ref 可作 evidence.ref，type 填 METRIC；带"趋势"的来自指标快照采样，没有趋势的只是告警瞬时值）'
        : '[指标]（仅告警上报时刻的快照，无时间序列，不要当趋势使用）',
    );
    let trendLines = 0;
    let trendSkipped = 0;
    for (const m of ctx.metrics) {
      const base = `- ${m.ref} | ${m.deviceName} ${m.metric} = ${m.value ?? '未知'}${m.threshold !== null ? `（阈值 ${m.threshold}）` : ''} @ ${m.at}`;
      if (!m.trend) {
        push(base);
        continue;
      }
      // 趋势只展开前 3 条：第 4 条起的斜率对定因没有增量，却要吃掉上下文预算（§3.5）
      if (trendLines >= MAX_TREND_LINES) {
        trendSkipped += 1;
        push(`${base}${m.unit ? ` ${m.unit}` : ''}（有采样曲线）`);
        continue;
      }
      const t = m.trend;
      const direction = t.slopePerMin > 0 ? '上升' : t.slopePerMin < 0 ? '下降' : '持平';
      push(`${base}${m.unit ? ` ${m.unit}` : ''}`);
      push(
        `  趋势：${t.samples} 点，首 ${t.first} → 末 ${t.last}，峰 ${t.max} / 谷 ${t.min}，${direction} ${Math.abs(t.slopePerMin)}/分钟（${t.from} ~ ${t.to}）`,
      );
      trendLines += 1;
    }
    if (trendSkipped > 0) {
      push(`[注] 另有 ${trendSkipped} 条指标有采样曲线，因长度限制未展开，需要时按 ref 查询。`);
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
    // 只留 title + tags：案例的现象/根因/处置三段曾占掉整个上下文的三分之一，
    // 而"哪类故障曾经怎么处理"这件事，标签已经说清了
    for (const c of ctx.cases) {
      push(`- ${c.id} | ${c.title} | tags：${c.tags.join('/')}`);
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
