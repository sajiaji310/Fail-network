import { alertTypeLabel, deviceLayerLabel } from '@/modules/alerts/labels';
import { familyOf } from '@/modules/correlation/affinity';
import type { AnalysisResult, HypothesisCategory, HypothesisDraft } from './schema';
import type { ContextAlert, ContextBundle, ContextChange } from './context';

/**
 * 规则 fallback（文档 10.4）：无 LLM key / 模型连续失败时的兜底。
 *
 * 打分权重直接照抄文档，不自己发明：
 *   变更相关 +40 · 直连告警 +30 · 类型权重 +20 · 历史相似 +10
 * 分数除以 100 得 confidence，上限 0.95 —— 规则引擎没资格给"接近确定"。
 *
 * 刻意做成纯函数：输入 ContextBundle，输出 AnalysisResult，不碰数据库、不碰网络。
 * 这样它既能给无 key 环境兜底，也能在评测里当"基线模型"跟 LLM 对比。
 */

const WEIGHT = { CHANGE: 40, CHANGE_NEIGHBOR: 20, ADJACENT: 30, TYPE: 20, CASE: 10 } as const;
const MIN_CANDIDATE_SCORE = 40;

const CLASS_SCORE = { ROOT: 20, PARENT: 16, CHILD: 8, UNKNOWN: 4 } as const;
const CLASS_RANK = { ROOT: 3, PARENT: 2, CHILD: 1, UNKNOWN: 0 } as const;
const SEVERITY_RANK = { P0: 4, P1: 3, P2: 2, P3: 1 } as const;

type Candidate = {
  deviceId: string;
  deviceName: string;
  layer: number;
  alert: ContextAlert | null;
  change: ContextChange | null;
  score: number;
  reasons: string[];
};

/** 一台设备"最有代表性"的那条告警：先看类别，再看严重度，最后取最早的 */
function pickPrimaryAlert(alerts: readonly ContextAlert[]): ContextAlert | null {
  let best: ContextAlert | null = null;
  for (const alert of alerts) {
    if (!best) {
      best = alert;
      continue;
    }
    const rankDiff = CLASS_RANK[alert.alertClass] - CLASS_RANK[best.alertClass];
    const sevDiff = SEVERITY_RANK[alert.severity] - SEVERITY_RANK[best.severity];
    if (rankDiff > 0 || (rankDiff === 0 && sevDiff > 0)) best = alert;
    else if (rankDiff === 0 && sevDiff === 0 && alert.firstSeen < best.firstSeen) best = alert;
  }
  return best;
}

function categoryOf(alert: ContextAlert | null, change: ContextChange | null): HypothesisCategory {
  if (change) return 'CONFIG';
  if (!alert) return 'OTHER';
  if (alert.alertClass === 'ROOT' || alert.alertClass === 'PARENT') return 'HARDWARE';
  const family = familyOf(alert.type);
  if (family === 'LINK') return 'LINK';
  if (family === 'ROUTING') return 'UPSTREAM';
  if (family === 'RESOURCE') return 'CAPACITY';
  if (family === 'QUALITY') return 'LINK';
  return 'OTHER';
}

function causeOf(
  deviceName: string,
  alert: ContextAlert | null,
  change: ContextChange | null,
): string {
  if (change) {
    const brief = change.content.length > 46 ? `${change.content.slice(0, 46)}…` : change.content;
    return `${deviceName} 在事件前执行了 ${change.kind} 变更（${brief}），配置异常沿拓扑向下游扩散`;
  }
  if (!alert) return `${deviceName} 存在未定位的异常，需补充采集`;
  const label = alertTypeLabel(alert.type);
  if (alert.alertClass === 'ROOT') {
    return `${deviceName} 发生${label}，硬件异常导致本机转发能力下降，下游告警为连带现象`;
  }
  if (alert.alertClass === 'PARENT') {
    return `${deviceName} ${label}（整机不可达），下游端口与邻居告警是失联后的连带结果`;
  }
  const family = familyOf(alert.type);
  if (family === 'LINK')
    return `${deviceName} 上联链路/端口异常（${label}），链路层故障导致丢包或中断`;
  if (family === 'ROUTING')
    return `${deviceName} 邻居或路由策略异常（${label}），路由收敛异常放大影响面`;
  if (family === 'QUALITY') return `${deviceName} 出现质量劣化（${label}），链路丢包与时延上升`;
  if (family === 'RESOURCE') return `${deviceName} 资源过载（${label}），转发性能下降`;
  return `${deviceName} 上报${label}，需结合现场进一步定位`;
}

function verifyStepsOf(category: HypothesisCategory, deviceName: string): string[] {
  if (category === 'HARDWARE') {
    return [
      `登录 ${deviceName} 查看硬件状态（电源/风扇/板卡/温度），确认是否有部件告警`,
      '核对该设备上联端口是否成批 Down，判断故障是否自下而上扩散',
      `联系现场确认 ${deviceName} 近 24h 是否有上电、更换或搬迁操作`,
    ];
  }
  if (category === 'CONFIG') {
    return [
      '调出变更前后配置 diff，确认是否影响转发路径或策略',
      '在维护窗口回滚该变更，观察告警是否随之收敛',
    ];
  }
  if (category === 'LINK') {
    return [
      '检查端口 CRC/错包计数与光功率，确认是否低于接收灵敏度',
      '用备用尾纤或光模块交叉验证，排除介质问题',
    ];
  }
  return [
    '查看设备日志中首个异常时间点前后的接口与邻居事件',
    '确认上游设备状态，排除上游故障向下传导',
  ];
}

function actionsOf(category: HypothesisCategory, deviceName: string): HypothesisDraft['actions'] {
  if (category === 'HARDWARE') {
    return [
      {
        action: `准备同型号备件并安排 ${deviceName} 更换窗口`,
        risk: 'HIGH',
        requiresApproval: true,
      },
      { action: '更换前先将业务流量切至冗余路径', risk: 'MEDIUM', requiresApproval: true },
    ];
  }
  if (category === 'CONFIG') {
    return [
      { action: '在维护窗口回滚该变更并观察 15 分钟', risk: 'MEDIUM', requiresApproval: true },
      { action: '补充变更评审与灰度验证流程', risk: 'LOW', requiresApproval: false },
    ];
  }
  if (category === 'LINK') {
    return [
      { action: '切换至备用链路，降低业务影响', risk: 'MEDIUM', requiresApproval: true },
      { action: '更换光模块/尾纤后复测误码', risk: 'LOW', requiresApproval: false },
    ];
  }
  return [{ action: '持续观察 2 个采集周期并补充指标', risk: 'LOW', requiresApproval: false }];
}

export function ruleFallback(ctx: ContextBundle): AnalysisResult {
  const alertsByDevice = new Map<string, ContextAlert[]>();
  for (const alert of ctx.alerts) {
    const list = alertsByDevice.get(alert.deviceId) ?? [];
    list.push(alert);
    alertsByDevice.set(alert.deviceId, list);
  }

  const changesByDevice = new Map<string, ContextChange[]>();
  for (const change of ctx.changes) {
    // 晚于首个告警的变更不可能是原因（与校验器 L2 同口径）
    if (!change.beforeFirstAlert) continue;
    const list = changesByDevice.get(change.deviceId) ?? [];
    list.push(change);
    changesByDevice.set(change.deviceId, list);
  }

  const incidentDeviceIds = new Set(ctx.nodes.map((n) => n.id));
  const directNeighborsOf = (deviceId: string): string[] =>
    ctx.links
      .filter((l) => l.sourceId === deviceId || l.targetId === deviceId)
      .map((l) => (l.sourceId === deviceId ? l.targetId : l.sourceId));

  const candidateIds = new Set<string>([
    ...incidentDeviceIds,
    // 上游变更即使自身没告警也可能是根因（ACL 变更剧本），必须进候选池
    ...ctx.changes.filter((c) => c.beforeFirstAlert).map((c) => c.deviceId),
  ]);

  const candidates: Candidate[] = [];
  for (const deviceId of candidateIds) {
    const alerts = alertsByDevice.get(deviceId) ?? [];
    const alert = pickPrimaryAlert(alerts);
    const changes = changesByDevice.get(deviceId) ?? [];
    const change = changes[0] ?? null;
    const node = ctx.nodes.find((n) => n.id === deviceId);
    const name = node?.name ?? change?.deviceName ?? alerts[0]?.deviceName ?? deviceId;

    let score = 0;
    const reasons: string[] = [];

    if (change) {
      // 事件设备或 1 跳邻居的变更才拿满 40 分；更远的变更只留 20（仍可能是上游原因，但证据弱）
      const nearby =
        incidentDeviceIds.has(deviceId) ||
        directNeighborsOf(deviceId).some((id) => incidentDeviceIds.has(id));
      score += nearby ? WEIGHT.CHANGE : WEIGHT.CHANGE_NEIGHBOR;
      reasons.push('事件前有变更');
    }

    const adjacent = directNeighborsOf(deviceId).filter((id) => incidentDeviceIds.has(id));
    if (adjacent.length > 0) {
      score += WEIGHT.ADJACENT;
      reasons.push(`直连 ${adjacent.length} 台受影响设备`);
    }

    if (alert) {
      score += CLASS_SCORE[alert.alertClass];
      reasons.push(`${alert.alertClass} 类告警`);
    }

    if (ctx.cases.length > 0 && (alert?.alertClass === 'ROOT' || alert?.alertClass === 'PARENT')) {
      score += WEIGHT.CASE;
      reasons.push('命中历史相似案例');
    }

    if (score < MIN_CANDIDATE_SCORE) continue;
    candidates.push({
      deviceId,
      deviceName: name,
      layer: node?.layer ?? 3,
      alert,
      change,
      score: Math.min(score, WEIGHT.CHANGE + WEIGHT.ADJACENT + WEIGHT.TYPE + WEIGHT.CASE),
      reasons,
    });
  }

  candidates.sort((a, b) => b.score - a.score || a.deviceName.localeCompare(b.deviceName));
  const top = candidates.slice(0, 3);

  if (top.length === 0) {
    return {
      summary: `未能在现有证据中定位根因（${ctx.incident.deviceCount} 台设备受影响）`,
      impactScope: `${ctx.incident.deviceCount} 台设备、${ctx.incident.alertCount} 条告警，证据不足`,
      severity: ctx.incident.severity,
      hypotheses: [],
      missingInfo: ['缺少可用于归因的告警或变更证据，建议补充拓扑与变更数据源'],
    };
  }

  const hypotheses: HypothesisDraft[] = top.map((candidate, index) => {
    const category = categoryOf(candidate.alert, candidate.change);
    const evidence: HypothesisDraft['evidence'] = [];

    if (candidate.alert) {
      evidence.push({
        type: 'ALERT',
        ref: candidate.alert.id,
        desc: `${candidate.deviceName} ${alertTypeLabel(candidate.alert.type)}（${candidate.alert.severity}，累计 ${candidate.alert.count} 次）`,
      });
    }
    if (candidate.change) {
      evidence.push({
        type: 'CHANGE',
        ref: candidate.change.id,
        desc: `${candidate.change.kind} 变更：${candidate.change.content.slice(0, 60)}`,
      });
    }
    const link = ctx.links.find(
      (l) =>
        (l.sourceId === candidate.deviceId || l.targetId === candidate.deviceId) &&
        l.hopsToIncident <= 1,
    );
    if (link) {
      evidence.push({
        type: 'TOPOLOGY',
        ref: link.id,
        desc: `${link.sourceName} <-> ${link.targetName}（${link.status}）`,
      });
    }
    const related = ctx.cases[0];
    if (related && candidate.alert) {
      evidence.push({ type: 'CASE', ref: related.id, desc: `历史案例：${related.title}` });
    }

    const confidence = Math.min(0.95, Math.max(0.15, candidate.score / 100 - index * 0.08));

    return {
      cause: causeOf(candidate.deviceName, candidate.alert, candidate.change),
      category,
      confidence: Math.round(confidence * 1000) / 1000,
      evidence: evidence.slice(0, 4),
      verifySteps: verifyStepsOf(category, candidate.deviceName),
      actions: actionsOf(category, candidate.deviceName),
    };
  });

  const head = top[0];
  if (!head) {
    return {
      summary: `未能在现有证据中定位根因（${ctx.incident.deviceCount} 台设备受影响）`,
      impactScope: `${ctx.incident.deviceCount} 台设备、${ctx.incident.alertCount} 条告警，证据不足`,
      severity: ctx.incident.severity,
      hypotheses: [],
      missingInfo: ['缺少可用于归因的告警或变更证据，建议补充拓扑与变更数据源'],
    };
  }
  const layers = [...new Set(ctx.nodes.map((n) => deviceLayerLabel(n.layer)))].join('/');
  const summaryBase = head.change
    ? `${head.deviceName} 的 ${head.change.kind} 变更为首要怀疑对象，${ctx.incident.deviceCount} 台设备受影响`
    : `${head.deviceName} ${head.alert ? alertTypeLabel(head.alert.type) : '异常'}为最可能根因，${ctx.incident.deviceCount} 台设备受影响`;

  return {
    summary: summaryBase.slice(0, 200),
    impactScope: `${layers}共 ${ctx.incident.deviceCount} 台设备、${ctx.incident.alertCount} 条告警（抑制 ${ctx.incident.suppressedCount} 条）`,
    severity: ctx.incident.severity,
    hypotheses,
    missingInfo:
      ctx.changes.length === 0
        ? ['事件前 24h 内没有变更记录，若上游未接入变更数据源，请补齐后再研判']
        : [],
  };
}
