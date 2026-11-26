import { alertTypeLabel, deviceLayerLabel } from '@/modules/alerts/labels';
import { familyOf } from '@/modules/correlation/affinity';
import { categoryOfType, isExplainedType } from './explainability';
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

const WEIGHT = {
  CHANGE: 40,
  CHANGE_NEIGHBOR: 20,
  ADJACENT: 30,
  SELF: 15,
  TYPE: 20,
  CASE: 10,
} as const;
/**
 * 候选分下限（T09 评测后从 40 调到 20）。
 *
 * 原值 40 隐含要求"至少有一条强信号"：变更(40) 或 直连(30)+设备级告警(20)。
 * 但纯链路/质量类故障（光模块劣化、端口抖动、解析超时）根本没有设备级告警，
 * 最高只能拿到 直连 30 + CHILD 8 = 38，于是整类场景一律返回空结论。
 * 评测集 dev-02/04/06/08/11 全部因此失败 —— 这不是"谨慎"，是把一类故障判死了。
 *
 * 20 = 自身在事件内的基准分。语义变成：**事件内每台有可解释告警的设备都是嫌疑**，
 * 由分数排序决定谁排第一，而不是先一刀切掉大半。
 * 噪声仍挡得住：告警类型未登记的设备拿不到 SELF 分，孤立单设备只有 4 分（AC-20）。
 */
const MIN_CANDIDATE_SCORE = 20;

const CLASS_SCORE = { ROOT: 20, PARENT: 16, CHILD: 8, UNKNOWN: 4 } as const;
const CLASS_RANK = { ROOT: 3, PARENT: 2, CHILD: 1, UNKNOWN: 0 } as const;
const SEVERITY_RANK = { P0: 4, P1: 3, P2: 2, P3: 1 } as const;

type Candidate = {
  deviceId: string;
  deviceName: string;
  layer: number;
  alert: ContextAlert | null;
  change: ContextChange | null;
  /** 该设备在本事件里的告警条数：同分时用它决定谁更像故障源 */
  alertCount: number;
  /** 该设备最高告警等级：条数也一样时，P1 比 P3 更像根因 */
  severity: ContextAlert['severity'];
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
  // 归因口径住在 explainability.ts（提示词与校验器也读它），这里只负责"变更优先"这一层
  return categoryOfType(alert.type, alert.alertClass) ?? 'OTHER';
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

/** 打分与排序在下一层：归因（category）不在这里判，统一交给 explainability.ts */
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
      // 自身就在事件里：这是"嫌疑"的底线，不是结论。没有它，纯链路类故障（无设备级告警）
      // 会连候选都进不来。两条排除：
      //  - 未登记类型不给分（那是"看不懂"，不是"可疑"，AC-20 靠它兜底）
      //  - ROOT/PARENT 告警已经拿了 20/16 分，不再叠加，否则设备级故障会把
      //    "变更 + 直连"的最高分（40+30）压下去，ACL 类根因就排不到第一了
      if (
        isExplainedType(alert.type) &&
        alert.alertClass !== 'ROOT' &&
        alert.alertClass !== 'PARENT'
      ) {
        score += WEIGHT.SELF;
        reasons.push('事件内设备');
      }
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
      alertCount: alerts.length,
      severity: alert?.severity ?? 'P3',
      score: Math.min(score, WEIGHT.CHANGE + WEIGHT.ADJACENT + WEIGHT.TYPE + WEIGHT.CASE),
      reasons,
    });
  }

  // 同分时的决胜顺序：告警更多（更像故障源）→ 最高等级更高 → 告警类别更高 → 名字（确定性）
  // 只看分数会让「对端设备」和「故障设备」并列：光模块场景里 AGG 与 ACC 都是 38 分，
  // 按名字序会把汇聚排前面，结论从"某个接入的光模块"变成"汇聚异常"。
  candidates.sort(
    (a, b) =>
      b.score - a.score ||
      b.alertCount - a.alertCount ||
      SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
      CLASS_RANK[b.alert?.alertClass ?? 'UNKNOWN'] - CLASS_RANK[a.alert?.alertClass ?? 'UNKNOWN'] ||
      a.deviceName.localeCompare(b.deviceName),
  );
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
      // 3 条是输出契约的上限（Spec §3.6）：规则引擎的输出同样要能过 schema，
      // 否则无 key 环境的结论会被自己的校验器/缓存读取判为不可用
      evidence: evidence.slice(0, 3),
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
