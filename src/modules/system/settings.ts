import { db } from '@/lib/db';
import { env, llmMode, type LlmMode } from '@/lib/env';
import { getAuditSummary, listAudit, type AuditSummary } from '@/modules/audit/service';
import {
  CLUSTER_THRESHOLD,
  CLUSTER_WINDOW_MS,
  CONTINUATION_WINDOW_MS,
  FOLLOWUP_LOOKBACK_MS,
  MAX_HOPS,
  MERGE_MIN_SHARED_DEVICES,
  MERGE_OVERLAP_RATIO,
  MIN_ALERTS_PER_INCIDENT,
  REOPEN_WINDOW_MS,
  SCORE_TIE_EPSILON,
  TOPOLOGY_PROXIMITY,
  WEIGHTS,
} from '@/modules/correlation/constants';
import { listScenarios, loadScenario } from '@/modules/ingest/scenario';

/**
 * 设置页读模型（文档 11.1 `/settings`：模型配置只读展示 env、聚合阈值、剧本注入入口）。
 *
 * 这个页面的定位是「把散在 env 和代码常量里的运行参数摊开给人看」，不是可编辑的配置中心：
 * MVP-0 没有配置表，改参数就该改 `.env` 或 `constants.ts` 然后重启 —— 做成页面上的开关
 * 反而会出现"页面显示 0.55、代码里是 0.60"的双份事实。
 *
 * 所以这里只读；唯一有副作用的是剧本注入，它走已有的 `/api/v1/ingest/simulate`。
 */

export type ModelConfig = {
  mode: LlmMode;
  /** 模式的人话解释，直接渲染，避免用户在页面上猜 fallback 是什么意思 */
  modeLabel: string;
  modeNote: string;
  provider: string;
  modelFast: string;
  modelReason: string;
  /** null = 没配 key；否则是脱敏后的尾号 */
  keyMasked: string | null;
  mock: boolean;
  logLevel: string;
  simSeed: string;
};

export type TokenRow = {
  model: string;
  source: string;
  calls: number;
  tokens: number;
};

export type TokenUsage = {
  calls: number;
  tokens: number;
  rows: TokenRow[];
};

export type ThresholdRow = { label: string; value: string; note?: string };
export type ThresholdGroup = { title: string; hint: string; rows: ThresholdRow[] };

export type ScenarioItem = {
  name: string;
  desc: string;
  alerts: number;
  changes: number;
};

const MODE_TEXT: Record<LlmMode, { label: string; note: string }> = {
  live: {
    label: '真实调用',
    note: `已配置 API Key，研判会真的打模型（${env.LLM_MODEL_REASON}）。每次调用的 token 计入下方消耗。`,
  },
  fallback: {
    label: '规则降级',
    note: 'LLM_API_KEY 为空，研判走规则引擎：变更 +40 / 直连 +30 / 自证 +15 / 类型 +20 / 历史 +10。结论可用，但不会自我解释。',
  },
  mock: {
    label: 'Mock',
    note: 'LLM_MOCK=true，返回固定 fixture。仅用于跑测试与 E2E，fixture 里刻意含一条引用不存在 ID 的假设来验证 L1 丢弃。',
  },
};

/** 脱敏：只留尾 4 位。短 key 一律退化成 ***，避免"末 4 位"本身就是大半把钥匙 */
function maskKey(raw: string): string | null {
  const key = raw.trim();
  if (key.length === 0) return null;
  if (key.length < 12) return '已配置（***）';
  return `已配置（…${key.slice(-4)}）`;
}

export function getModelConfig(): ModelConfig {
  const mode = llmMode();
  const { label, note } = MODE_TEXT[mode];
  return {
    mode,
    modeLabel: label,
    modeNote: note,
    provider: env.LLM_BASE_URL,
    modelFast: env.LLM_MODEL_FAST,
    modelReason: env.LLM_MODEL_REASON,
    keyMasked: maskKey(env.LLM_API_KEY),
    mock: env.LLM_MOCK === 'true',
    logLevel: env.LOG_LEVEL,
    simSeed: env.SIM_DEFAULT_SEED,
  };
}

/**
 * 累计 token 消耗（文档 11.1 的"设置页展示累计消耗"）。
 *
 * 按 model + source 分组而不是只求和：fallback 产生的假设 tokensUsed 是 null，
 * 混在一起求和会让人误以为"跑了很多但没花钱"，分开看才知道钱花在哪个模型上。
 */
export async function getTokenUsage(): Promise<TokenUsage> {
  try {
    const grouped = await db.hypothesis.groupBy({
      by: ['model', 'source'],
      _sum: { tokensUsed: true },
      _count: { _all: true },
    });

    const rows: TokenRow[] = grouped
      .map((g) => ({
        model: g.model ?? '—',
        source: g.source,
        calls: g._count._all,
        tokens: g._sum.tokensUsed ?? 0,
      }))
      .sort((a, b) => b.tokens - a.tokens || b.calls - a.calls);

    return {
      calls: rows.reduce((sum, r) => sum + r.calls, 0),
      tokens: rows.reduce((sum, r) => sum + r.tokens, 0),
      rows,
    };
  } catch {
    // 库没起也要能打开设置页：降级成 0，页面上「库已连接」那张卡会同步变红
    return { calls: 0, tokens: 0, rows: [] };
  }
}

function minutes(ms: number): string {
  const m = ms / 60_000;
  return Number.isInteger(m) ? `${m} 分钟` : `${m.toFixed(1)} 分钟`;
}

export function getThresholds(): ThresholdGroup[] {
  return [
    {
      title: '打分与成簇',
      hint: '文档 4.1',
      rows: [
        { label: '拓扑接近度权重', value: WEIGHTS.TOPOLOGY.toFixed(2) },
        { label: '时间邻近权重', value: WEIGHTS.TIME.toFixed(2) },
        { label: '类型一致权重', value: WEIGHTS.TYPE.toFixed(2) },
        { label: '成簇阈值', value: CLUSTER_THRESHOLD.toFixed(2), note: '总分低于此值不并簇' },
        {
          label: '平局合并容差',
          value: SCORE_TIE_EPSILON.toFixed(2),
          note: 'B2：分差小于它直接合并',
        },
        {
          label: '单事件告警下限',
          value: `${MIN_ALERTS_PER_INCIDENT} 条`,
          note: '低于此值不成事件',
        },
      ],
    },
    {
      title: '时间窗',
      hint: '文档 4.2',
      rows: [
        { label: '簇内滑窗', value: minutes(CLUSTER_WINDOW_MS), note: 'B1：任意两条告警的硬上限' },
        {
          label: '延续窗口',
          value: minutes(CONTINUATION_WINDOW_MS),
          note: 'B5：同一设备再现即沿用事件',
        },
        {
          label: '沿用回看',
          value: `${minutes(FOLLOWUP_LOOKBACK_MS)}`,
          note: 'B5：只回看最近这么久的告警',
        },
        { label: '结案重开', value: minutes(REOPEN_WINDOW_MS), note: 'B6' },
      ],
    },
    {
      title: '拓扑',
      hint: '文档 4.2 B7',
      rows: [
        { label: '最大合并跳数', value: `${MAX_HOPS} 跳`, note: '超过即视为不可达' },
        { label: '同设备', value: TOPOLOGY_PROXIMITY.SAME_DEVICE.toFixed(1) },
        { label: '直连', value: TOPOLOGY_PROXIMITY.DIRECT.toFixed(1) },
        { label: '两跳', value: TOPOLOGY_PROXIMITY.TWO_HOPS.toFixed(1) },
        { label: '不可达', value: TOPOLOGY_PROXIMITY.NONE.toFixed(1) },
      ],
    },
    {
      title: '簇合并',
      hint: '文档 4.2 B3',
      rows: [
        { label: '共享设备下限', value: `${MERGE_MIN_SHARED_DEVICES} 台` },
        {
          label: '时间重叠下限',
          value: MERGE_OVERLAP_RATIO.toFixed(2),
          note: 'Jaccard：交集 / 并集',
        },
      ],
    },
  ];
}

/**
 * 剧本清单。直接从 `scripts/fixtures/scenarios` 读，和 `npm run sim -- --list`
 * 是同一份文件，所以 CLI 能看到几个、页面上就有几个。
 */
export function getScenarios(): ScenarioItem[] {
  try {
    return listScenarios().map((name) => {
      const spec = loadScenario(name);
      return {
        name,
        desc: spec.description,
        alerts: spec.alerts.length,
        changes: spec.changes.length,
      };
    });
  } catch {
    // 剧本目录没打进镜像 / 文件损坏：降级成空列表，页面显示"没有可用剧本"
    return [];
  }
}

/** 审计动作的中文名。新增动作要同步这里，否则页面会显示原始 key */
const ACTION_LABEL: Record<string, string> = {
  'analyze.run': '执行研判',
  'hypothesis.verdict': '假设裁决',
  'incident.transition': '事件流转',
  'alert.ingest': '告警导入',
  'scenario.inject': '剧本注入',
  'correlation.run': '手动聚合',
  'report.generate': '生成报告',
  'case.verify': '案例确认',
};

export function auditActionLabel(action: string): string {
  return ACTION_LABEL[action] ?? action;
}

/** detail 里值得摊在列表上的字段，按这个顺序取，最多 4 个 */
const DETAIL_KEYS = [
  'from',
  'to',
  'verdict',
  'verification',
  'scenario',
  'reset',
  'force',
  'rows',
  'accepted',
  'created',
  'updated',
  'merged',
  'reopened',
  'code',
  'charCount',
] as const;

export type AuditRow = {
  id: string;
  at: string;
  action: string;
  actionLabel: string;
  actor: string;
  target: string | null;
  ok: boolean;
  /** 人话摘要：`from=OPEN · to=RESOLVED`；失败时是错误码 */
  summary: string;
};

export type AuditPanel = {
  summary: AuditSummary;
  rows: AuditRow[];
};

function summarizeDetail(detail: Record<string, unknown> | null): string {
  if (!detail) return '';
  const error = detail.error as { code?: string } | undefined;
  if (error?.code) return `失败：${error.code}`;

  const parts: string[] = [];
  for (const key of DETAIL_KEYS) {
    const value = detail[key];
    if (value === undefined || value === null || value === '') continue;
    if (typeof value === 'boolean' && !value) continue;
    parts.push(`${key}=${String(value)}`);
    if (parts.length >= 4) break;
  }
  return parts.join(' · ');
}

/**
 * 设置页的「操作审计」卡片数据。
 *
 * 只展示最近 12 条：这是给人快速确认"刚刚那下点成功了没有"用的，
 * 真要按时间/动作翻查走 `GET /api/v1/audit`，别把页面做成日志浏览器。
 */
export async function getAuditPanel(limit = 12): Promise<AuditPanel> {
  try {
    const [summary, items] = await Promise.all([getAuditSummary(), listAudit({ limit })]);
    return {
      summary,
      rows: items.map((item) => ({
        id: item.id,
        at: item.at,
        action: item.action,
        actionLabel: ACTION_LABEL[item.action] ?? item.action,
        actor: item.actor,
        target: item.target,
        ok: item.result === 'OK',
        summary: summarizeDetail(item.detail),
      })),
    };
  } catch {
    return {
      summary: { total: 0, last24h: 0, failures: 0, byAction: [] },
      rows: [],
    };
  }
}
