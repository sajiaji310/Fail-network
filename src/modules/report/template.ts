import { format } from 'date-fns';
import { duration } from '@/lib/utils/time';

/**
 * 复盘报告模板（AC-09）。
 *
 * 固定四段：MTTR / 影响面 / 根因 / 改进项。不做"智能排版"——
 * 这份文本的消费场景是复制进周报或 IM 群，结构稳定比好看重要。
 *
 * 纯函数：不读库、不读时钟（generatedAt 由调用方传入），同输入同输出。
 * 缺数据时也要把段落标题写全，并明确说清"缺什么" —— 报告里出现空段落，
 * 会让读的人以为系统漏了东西。
 */

export type ReportIncident = {
  code: string;
  title: string;
  severity: string;
  status: string;
  startedAt: Date;
  resolvedAt: Date | null;
  lastSeen: Date;
  mttrSeconds: number | null;
  summary: string | null;
  impactScope: string | null;
  reopenedCount: number;
  closureNote: string | null;
};

export type ReportDevice = {
  name: string;
  layer: number;
  alertCount: number;
  suppressedCount: number;
  maxSeverity: string;
};

export type ReportHypothesis = {
  rank: number;
  cause: string;
  category: string;
  confidence: number;
  source: string;
  verdict: string | null;
  evidence: readonly { type: string; ref: string; desc: string }[];
  verifySteps: readonly string[];
  actions: readonly { action: string; risk: string; requiresApproval: boolean }[];
};

export type ReportChange = {
  deviceName: string;
  kind: string;
  content: string;
  changedAt: Date;
};

export type ReportAlertSummary = {
  total: number;
  suppressed: number;
  /** 告警类型 → 条数，按条数降序 */
  types: readonly { type: string; count: number }[];
};

export type ReportInput = {
  incident: ReportIncident;
  devices: readonly ReportDevice[];
  alerts: ReportAlertSummary;
  hypotheses: readonly ReportHypothesis[];
  changes: readonly ReportChange[];
  generatedAt: Date;
};

const LAYER_LABEL: Record<number, string> = { 1: '核心', 2: '汇聚', 3: '接入' };

const CATEGORY_LABEL: Record<string, string> = {
  HARDWARE: '硬件',
  CONFIG: '配置',
  LINK: '链路',
  CAPACITY: '容量',
  UPSTREAM: '上游',
  OTHER: '其它',
};

const RISK_LABEL: Record<string, string> = { LOW: '低风险', MEDIUM: '中风险', HIGH: '高风险' };

/** 兜底改进项：没有处置建议时也必须给出可执行动作，而不是留空 */
const BASELINE_IMPROVEMENTS = [
  '把本次故障的现象补进监控基线：为该设备/端口增加对应指标门限，避免下次只能靠用户报障发现。',
  '复核该类操作或部件的变更管控：变更前后各有一次影响面评估与回滚预案，避免同类问题在无感知的情况下复发。',
  '把本次场景固化为可注入的演练剧本，纳入月度演练，验证告警聚合与研判链路是否仍然有效。',
];

const stamp = (value: Date) => format(value, 'yyyy-MM-dd HH:mm:ss');

/** Markdown 表格单元格转义：内容里的竖线会把表结构切断 */
const cell = (value: string) => value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

export function buildReportMarkdown(input: ReportInput): string {
  const { incident, devices, alerts, hypotheses, changes } = input;
  const mttrSeconds = incident.mttrSeconds;
  const lines: string[] = [];

  lines.push(`# ${incident.code} 故障复盘报告`);
  lines.push('');
  lines.push(
    `> ${incident.title} ｜ 级别 ${incident.severity} ｜ 状态 ${incident.status} ｜ 生成于 ${stamp(input.generatedAt)}`,
  );
  lines.push('');

  // ── 1. MTTR ────────────────────────────────────────────────
  lines.push('## 1. MTTR');
  lines.push('');
  lines.push(`- 故障开始：${stamp(incident.startedAt)}`);
  lines.push(
    `- 恢复时间：${incident.resolvedAt ? stamp(incident.resolvedAt) : '尚未结案（最后一次告警上报：' + stamp(incident.lastSeen) + '）'}`,
  );
  lines.push(
    mttrSeconds !== null
      ? `- **MTTR：${duration(mttrSeconds)}**（${mttrSeconds} 秒，自首个告警至结案）`
      : '- **MTTR：待结案后确定**',
  );
  if (incident.reopenedCount > 0) {
    lines.push(`- 重开次数：${incident.reopenedCount} 次（结案后 30 分钟内同簇再现自动重开）`);
  }
  if (incident.closureNote) {
    lines.push(`- 结案备注：${incident.closureNote}`);
  }
  lines.push('');

  // ── 2. 影响面 ──────────────────────────────────────────────
  lines.push('## 2. 影响面');
  lines.push('');
  const byLayer = new Map<number, number>();
  for (const device of devices) byLayer.set(device.layer, (byLayer.get(device.layer) ?? 0) + 1);
  const layerText = [...byLayer.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([layer, count]) => `${LAYER_LABEL[layer] ?? `L${layer}`} ${count}`)
    .join(' / ');

  lines.push(`- 受影响设备：${devices.length} 台${layerText ? `（${layerText}）` : ''}`);
  lines.push(
    `- 关联告警：${alerts.total} 条${alerts.suppressed > 0 ? `，其中 ${alerts.suppressed} 条被父告警抑制` : ''}`,
  );
  if (alerts.types.length > 0) {
    lines.push(`- 告警类型：${alerts.types.map((t) => `${t.type} ${t.count} 条`).join('，')}`);
  }
  lines.push(`- 窗口内变更：${changes.length} 条`);
  if (incident.impactScope) {
    lines.push('');
    lines.push(`影响面判读：${incident.impactScope}`);
  }
  lines.push('');

  if (devices.length > 0) {
    lines.push('| 设备 | 层级 | 告警数 | 抑制 | 最高级别 |');
    lines.push('|---|---|---|---|---|');
    for (const device of devices) {
      lines.push(
        `| ${cell(device.name)} | ${LAYER_LABEL[device.layer] ?? device.layer} | ${device.alertCount} | ${device.suppressedCount} | ${device.maxSeverity} |`,
      );
    }
    lines.push('');
  }

  // ── 3. 根因 ────────────────────────────────────────────────
  lines.push('## 3. 根因');
  lines.push('');
  const accepted = hypotheses.find((h) => h.verdict === 'ACCEPTED') ?? null;
  const primary = accepted ?? hypotheses[0] ?? null;

  if (!primary) {
    lines.push('- 结论：**未研判或证据不足**，系统未给出根因假设。');
    lines.push(
      '- 说明：所有候选假设都未通过证据校验时，系统宁可留空也不编造结论。建议补齐拓扑、指标或变更数据后重新研判。',
    );
  } else {
    const judge = accepted
      ? '人工采纳'
      : hypotheses.length > 0
        ? '系统首选（未人工确认）'
        : '未知来源';
    lines.push(
      `- 结论（${judge}）：**${primary.cause}**（置信度 ${Math.round(primary.confidence * 100)}%，来源 ${primary.source === 'RULE_FALLBACK' ? '规则引擎' : '模型研判'}，类别 ${CATEGORY_LABEL[primary.category] ?? primary.category}）`,
    );
    if (incident.summary && incident.summary !== primary.cause) {
      lines.push(`- 系统摘要：${incident.summary}`);
    }
    lines.push('');
    lines.push('证据链：');
    if (primary.evidence.length === 0) {
      lines.push('1. （无证据条目）');
    } else {
      primary.evidence.forEach((item, index) => {
        lines.push(`${index + 1}. [${item.type}] ${item.desc}（\`${item.ref}\`）`);
      });
    }

    const others = hypotheses.filter((h) => h !== primary);
    if (others.length > 0) {
      lines.push('');
      lines.push('其它候选（未采纳）：');
      for (const item of others) {
        const mark =
          item.verdict === 'REJECTED' ? ' — 已人工否决' : item.verdict === 'ACCEPTED' ? '' : '';
        lines.push(`- #${item.rank} ${item.cause}（${Math.round(item.confidence * 100)}%）${mark}`);
      }
    }

    if (primary.verifySteps.length > 0) {
      lines.push('');
      lines.push('验证步骤：');
      primary.verifySteps.forEach((step, index) => lines.push(`${index + 1}. ${step}`));
    }
  }
  lines.push('');

  // ── 4. 改进项 ──────────────────────────────────────────────
  lines.push('## 4. 改进项');
  lines.push('');
  const improvements: string[] = [];
  const seen = new Set<string>();
  // 只取"根因假设"的处置建议：被否决的候选假设的处置动作与本次故障无关，
  // 混进改进项会让读者以为系统建议把每条猜测都当故障处理一遍
  for (const action of primary?.actions ?? []) {
    if (improvements.length >= 3) break;
    if (seen.has(action.action)) continue;
    seen.add(action.action);
    const risk = RISK_LABEL[action.risk] ?? action.risk;
    improvements.push(
      `${action.action}（${risk}${action.requiresApproval ? '，需审批后执行' : ''}）`,
    );
  }
  for (const fallback of BASELINE_IMPROVEMENTS) {
    if (improvements.length >= 3) break;
    improvements.push(fallback);
  }
  improvements.forEach((item, index) => lines.push(`${index + 1}. ${item}`));
  lines.push('');

  return lines.join('\n');
}
