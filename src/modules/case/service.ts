import type { CaseVerification, Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { alertTypeLabel, deviceLayerLabel } from '@/modules/alerts/labels';
import type { IncidentDetail } from '@/modules/incidents/detail';
import type { HypothesisView } from '@/modules/incidents/hypothesis-view';

/**
 * 案例库（文档 F7「沉淀」+ AC-10 的数据来源）。
 *
 * MVP-0 只做关键词检索（决策 8：语义检索后置，字段先立住）。检索实现是两个
 * 容易忽略的点：
 * 1. **多词按 AND**：搜"光模块 抖动"时，两个词都命中才算相关，否则等于按词表堆噪声。
 * 2. **标签走 `has`**：tags 是 text[]，用 contains 会退化成字符串匹配。
 *
 * 可信度分级（评审 P0-3「案例污染率 = 0」）：
 * 结案时若有人工采纳的假设 → VERIFIED；只有系统首选 → UNVERIFIED。
 * UNVERIFIED 的案例照常留在库里可查（它是线索不是结论），但**不进 RCA 召回**。
 */

const CATEGORY_LABEL: Record<string, string> = {
  HARDWARE: '硬件',
  CONFIG: '配置',
  LINK: '链路',
  CAPACITY: '容量',
  UPSTREAM: '上游',
  OTHER: '其它',
};

export type CaseDraft = {
  title: string;
  symptom: string;
  rootCause: string;
  resolution: string;
  tags: string[];
  verification: CaseVerification;
  verifyNote: string | null;
};

export type CaseListItem = {
  id: string;
  incidentId: string;
  incidentCode: string;
  incidentTitle: string;
  severity: string;
  incidentStatus: string;
  resolvedAt: string | null;
  mttrSeconds: number | null;
  title: string;
  symptom: string;
  rootCause: string;
  resolution: string;
  tags: string[];
  verification: CaseVerification;
  verifiedAt: string | null;
  verifyNote: string | null;
  createdAt: string;
};

export type CaseQuery = {
  q?: string;
  tag?: string;
  verification?: CaseVerification;
  page?: number;
  pageSize?: number;
  /** 租户范围；不传按 default */
  tenantId?: string;
};

export type CaseListResult = {
  items: CaseListItem[];
  total: number;
  page: number;
  pageSize: number;
};

type CaseRow = {
  id: string;
  incidentId: string;
  title: string;
  symptom: string;
  rootCause: string;
  resolution: string;
  tags: string[];
  verification: CaseVerification;
  verifiedAt: Date | null;
  verifyNote: string | null;
  createdAt: Date;
  incident: {
    code: string;
    title: string;
    severity: string;
    status: string;
    resolvedAt: Date | null;
    mttrSeconds: number | null;
  };
};

const CASE_SELECT = {
  id: true,
  incidentId: true,
  title: true,
  symptom: true,
  rootCause: true,
  resolution: true,
  tags: true,
  verification: true,
  verifiedAt: true,
  verifyNote: true,
  createdAt: true,
  incident: {
    select: {
      code: true,
      title: true,
      severity: true,
      status: true,
      resolvedAt: true,
      mttrSeconds: true,
    },
  },
} satisfies Prisma.CaseRecordSelect;

function toListItem(row: CaseRow): CaseListItem {
  return {
    id: row.id,
    incidentId: row.incidentId,
    incidentCode: row.incident.code,
    incidentTitle: row.incident.title,
    severity: row.incident.severity,
    incidentStatus: row.incident.status,
    resolvedAt: row.incident.resolvedAt?.toISOString() ?? null,
    mttrSeconds: row.incident.mttrSeconds,
    title: row.title,
    symptom: row.symptom,
    rootCause: row.rootCause,
    resolution: row.resolution,
    tags: row.tags,
    verification: row.verification,
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
    verifyNote: row.verifyNote,
    createdAt: row.createdAt.toISOString(),
  };
}

const dedupe = (values: readonly string[]): string[] => [
  ...new Set(values.map((v) => v.trim()).filter(Boolean)),
];

/**
 * 从事件详情生成案例草稿。
 *
 * rootCause / resolution 的优先级刻意是"人工采纳 → 系统首选 → 结案备注"：
 * 人在评审时拍板的结论，永远比模型的自述更值得沉淀。
 */
export function buildCaseDraft(detail: IncidentDetail, accepted: HypothesisView | null): CaseDraft {
  const devices = detail.devices;
  const names = devices.map((d) => d.name);
  const head =
    names.length > 3
      ? `${names.slice(0, 3).join('、')} 等 ${names.length} 台设备`
      : names.join('、');
  const types = dedupe(detail.alerts.map((a) => alertTypeLabel(a.type))).slice(0, 4);
  const layers = dedupe(devices.map((d) => deviceLayerLabel(d.layer)));
  const mttr = detail.mttrSeconds ?? detail.stats.durationSeconds;
  const span =
    mttr >= 3600 ? `${Math.round(mttr / 3600)} 小时` : `${Math.max(1, Math.round(mttr / 60))} 分钟`;

  const symptom = [
    `${head || '相关设备'}在 ${span}内出现 ${types.join('、') || '多类告警'}`,
    detail.summary ? `；研判结论：${detail.summary}` : '。',
  ].join('');

  // 没有人工采纳时用系统首选，但必须在文本里标明"未人工确认"——
  // 案例库是下次研判的依据，不能让人把机器猜的当成老师傅确认过的
  const primary = accepted ?? detail.hypotheses[0] ?? null;
  const rootCause = primary
    ? accepted
      ? accepted.cause
      : `${primary.cause}（系统首选，未人工确认）`
    : (detail.summary ?? '结案时未给出根因假设（证据不足），仅记录现象与处置过程');
  const resolution =
    primary?.actions[0]?.action ??
    detail.closure?.note ??
    '按标准流程处置恢复，处置细节见事件时间线';

  const tags = dedupe([
    detail.severity,
    ...layers,
    ...types,
    primary ? (CATEGORY_LABEL[primary.category] ?? primary.category) : '未定位',
    detail.reopenedCount > 0 ? '重开' : '',
  ]);

  return {
    title: detail.title,
    symptom,
    rootCause,
    resolution,
    tags: tags.slice(0, 8),
    // 只有"人工采纳"才配叫已验证。系统首选单独存一条待确认案例，
    // 不许它下次以"历史经验"的身份回到研判上下文里。
    verification: accepted ? 'VERIFIED' : 'UNVERIFIED',
    verifyNote: accepted ? '结案时人工采纳了根因假设' : '系统首选，未经人工确认',
  };
}

/**
 * 结案沉淀：incidentId 唯一，重复结案（理论上不会发生）也只会更新同一条。
 *
 * 覆盖策略刻意不对称：**人工裁决优先**。案例被人在案例库里确认（或驳回）过之后，
 * 事件因重开再次结案时不会把它打回 UNVERIFIED —— 人的判断不该被系统的重复写入抹掉。
 */
export async function upsertCase(incidentId: string, draft: CaseDraft): Promise<string> {
  const [existing, incident] = await Promise.all([
    db.caseRecord.findUnique({
      where: { incidentId },
      select: { verification: true },
    }),
    // 案例继承事件所属租户：案例库按租户检索，不能靠 incidentId 二次 join 才知道归属
    db.incident.findUnique({ where: { id: incidentId }, select: { tenantId: true } }),
  ]);
  const keepManual = existing !== null && existing.verification !== 'UNVERIFIED';

  const row = await db.caseRecord.upsert({
    where: { incidentId },
    create: { incidentId, tenantId: incident?.tenantId ?? 'default', ...draft },
    update: {
      title: draft.title,
      symptom: draft.symptom,
      rootCause: draft.rootCause,
      resolution: draft.resolution,
      tags: draft.tags,
      ...(keepManual ? {} : { verification: draft.verification, verifyNote: draft.verifyNote }),
    },
    select: { id: true },
  });
  return row.id;
}

function keywordFilter(q: string): Prisma.CaseRecordWhereInput[] {
  const terms = q.trim().split(/\s+/).filter(Boolean).slice(0, 5);
  return terms.map((term) => ({
    OR: [
      { title: { contains: term, mode: 'insensitive' } },
      { symptom: { contains: term, mode: 'insensitive' } },
      { rootCause: { contains: term, mode: 'insensitive' } },
      { resolution: { contains: term, mode: 'insensitive' } },
      { tags: { has: term } },
    ],
  }));
}

export async function listCases(query: CaseQuery = {}): Promise<CaseListResult> {
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 20));
  const q = (query.q ?? '').trim();

  const where: Prisma.CaseRecordWhereInput = {
    tenantId: query.tenantId ?? 'default',
    ...(query.tag ? { tags: { has: query.tag } } : {}),
    ...(query.verification ? { verification: query.verification } : {}),
    ...(q ? { AND: keywordFilter(q) } : {}),
  };

  const [total, rows] = await Promise.all([
    db.caseRecord.count({ where }),
    db.caseRecord.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: CASE_SELECT,
    }),
  ]);

  return { items: rows.map(toListItem), total, page, pageSize };
}

/** 标签计数：给案例库的筛选项用，只统计最近 200 条，避免全表扫 */
export async function getCaseTagStats(
  limit = 12,
  tenantId = 'default',
): Promise<{ tag: string; count: number }[]> {
  const rows = await db.caseRecord.findMany({
    where: { tenantId },
    orderBy: { createdAt: 'desc' },
    take: 200,
    select: { tags: true },
  });
  const counter = new Map<string, number>();
  for (const row of rows) {
    for (const tag of row.tags) counter.set(tag, (counter.get(tag) ?? 0) + 1);
  }
  return [...counter.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([tag, count]) => ({ tag, count }));
}

export type CaseStats = {
  total: number;
  last7d: number;
  /** 已验证（可参与召回）/ 待确认 / 已驳回 */
  verified: number;
  unverified: number;
  rejected: number;
};

export async function getCaseStats(tenantId = 'default'): Promise<CaseStats> {
  const since = new Date(Date.now() - 7 * 24 * 3600_000);
  try {
    const [total, last7d, grouped] = await Promise.all([
      db.caseRecord.count({ where: { tenantId } }),
      db.caseRecord.count({ where: { tenantId, createdAt: { gte: since } } }),
      db.caseRecord.groupBy({ by: ['verification'], where: { tenantId }, _count: { _all: true } }),
    ]);
    const count = (v: CaseVerification) =>
      grouped.find((g) => g.verification === v)?._count._all ?? 0;

    return {
      total,
      last7d,
      verified: count('VERIFIED'),
      unverified: count('UNVERIFIED'),
      rejected: count('REJECTED'),
    };
  } catch {
    return { total: 0, last7d: 0, verified: 0, unverified: 0, rejected: 0 };
  }
}

export type CaseVerificationResult = {
  id: string;
  incidentCode: string;
  verification: CaseVerification;
  verifiedAt: string | null;
  verifyNote: string | null;
};

/**
 * 人工确认/驳回案例（`PATCH /api/v1/cases/[id]`）。
 *
 * 这是"待确认案例"的唯一晋升通道：结案时没采纳假设 → UNVERIFIED，
 * 事后有人在案例库里核对过、确认这条经验是对的 → VERIFIED，才开始参与召回。
 * 反方向也允许（VERIFIED → REJECTED），因为错误的经验比没有经验更危险。
 */
export async function setCaseVerification(input: {
  id: string;
  verification: CaseVerification;
  by: string;
  note?: string | null;
  now?: Date;
  tenantId?: string;
}): Promise<CaseVerificationResult | null> {
  const existing = await db.caseRecord.findFirst({
    where: { id: input.id, tenantId: input.tenantId ?? 'default' },
    select: { id: true, incident: { select: { code: true } } },
  });
  if (!existing) return null;

  const now = input.now ?? new Date();
  const manual = input.verification !== 'UNVERIFIED';
  const row = await db.caseRecord.update({
    where: { id: existing.id },
    data: {
      verification: input.verification,
      verifiedAt: manual ? now : null,
      verifiedBy: manual ? input.by : null,
      verifyNote: input.note?.trim() ? input.note.trim() : null,
    },
    select: { id: true, verification: true, verifiedAt: true, verifyNote: true },
  });

  return {
    id: row.id,
    incidentCode: existing.incident.code,
    verification: row.verification,
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
    verifyNote: row.verifyNote,
  };
}

/**
 * 相似案例检索（`GET /api/v1/cases/search`）。
 *
 * 有关键词就按关键词（OR，宁可多返回也不要空手，相似检索本来就是挑选而非过滤）；
 * 只给 incidentId 时，用该事件的"设备层级 + 告警类型"当关键词，并排除事件自身。
 */
export async function searchCases(params: {
  q?: string;
  incidentId?: string;
  limit?: number;
  tenantId?: string;
}): Promise<CaseListItem[]> {
  const limit = Math.min(20, Math.max(1, params.limit ?? 3));
  const tenantId = params.tenantId ?? 'default';
  let terms = (params.q ?? '').trim().split(/\s+/).filter(Boolean).slice(0, 6);
  let excludeIncidentId: string | null = null;

  if (params.incidentId) {
    // incidentId 参数可能是 code（INC-YYYYMMDD-NNN），先解析出真实 id 用于排除自身
    const incident = await db.incident.findFirst({
      where: { tenantId, OR: [{ id: params.incidentId }, { code: params.incidentId }] },
      select: {
        id: true,
        alerts: {
          take: 12,
          orderBy: { firstSeen: 'asc' },
          select: { fingerprint: { select: { type: true, device: { select: { layer: true } } } } },
        },
      },
    });
    if (incident) {
      excludeIncidentId = incident.id;
      if (terms.length === 0) {
        terms = dedupe([
          ...incident.alerts.map((a) => alertTypeLabel(a.fingerprint.type)),
          ...incident.alerts.map((a) => deviceLayerLabel(a.fingerprint.device.layer)),
        ]).slice(0, 6);
      }
    }
  }

  if (terms.length === 0) return [];

  const rows = await db.caseRecord.findMany({
    where: {
      tenantId,
      OR: terms.flatMap((term) => [
        { title: { contains: term, mode: 'insensitive' } },
        { symptom: { contains: term, mode: 'insensitive' } },
        { rootCause: { contains: term, mode: 'insensitive' } },
        { tags: { has: term } },
      ]),
      ...(excludeIncidentId ? { incidentId: { not: excludeIncidentId } } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: CASE_SELECT,
  });

  return rows.map(toListItem);
}
