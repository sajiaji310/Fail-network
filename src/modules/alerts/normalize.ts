import { Prisma, type AlertStatus, type Severity } from '@prisma/client';
import { db } from '@/lib/db';

/**
 * 4.3 告警生命周期：一个「发生周期」的判定规则。
 *
 * 关键点：判定锚点是**告警时间**而不是服务器当前时间。
 * 剧本回填的是历史时间轴（minuteFromStart），若用 wall clock 判定，
 * 历史数据全部会被误判为"超过 30 分钟"，AC-13 就永远测不出来。
 */
export const CYCLE_GAP_MS = 30 * 60 * 1000;

export type CycleAction = 'CREATED' | 'ACCUMULATED' | 'RESTARTED';

export type ActiveOccurrence = {
  id: string;
  status: AlertStatus;
  severity: Severity;
  count: number;
  firstSeen: Date;
  lastSeen: Date;
};

export type CycleDecision =
  | { kind: 'ACCUMULATE'; targetId: string; nextCount: number; nextLastSeen: Date }
  | { kind: 'NEW_CYCLE'; expireId: string | null };

const SEVERITY_RANK: Record<Severity, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

/** 取更严重的一档（P0 > P1 > P2 > P3） */
export function maxSeverity(a: Severity, b: Severity): Severity {
  return SEVERITY_RANK[a] <= SEVERITY_RANK[b] ? a : b;
}

/**
 * 周期锚点（参与 `(fingerprintId, cycleStart)` 唯一约束）。
 *
 * 早期实现取整到分钟，本意是让"同一批数据重复导入"稳定命中唯一键；
 * 但副作用很严重：告警被 RESOLVED 后在同一分钟内再次上报时，新周期的锚点
 * 与已关闭周期的锚点相同 → P2002 兜底逻辑把新告警合并进那条 RESOLVED 行，
 * 新周期直接消失（AC-14 的反向破坏）。
 *
 * 现在保留毫秒精度：同一条上游数据 firstSeen 完全相同，仍能命中唯一键；
 * 不同批次由 30 分钟规则判定，不再依赖取整。
 */
export function toCycleStart(date: Date): Date {
  return new Date(date);
}

/**
 * 纯判定（可单测，不碰数据库）：
 * - 活跃周期存在且间隔 < 30min → 累加（AC-13）
 * - 活跃周期存在但间隔 ≥ 30min → 关闭旧周期 + 新建（4.3 第二分支）
 * - 无活跃周期（新指纹 / 全是 RESOLVED）→ 新建，firstSeen 重置（AC-14）
 */
export function decideCycle(
  active: ActiveOccurrence | null,
  incoming: { firstSeen: Date; lastSeen: Date; count: number },
): CycleDecision {
  if (!active) return { kind: 'NEW_CYCLE', expireId: null };

  const gap = incoming.firstSeen.getTime() - active.lastSeen.getTime();
  // gap < 0 是乱序补报（上游重传/时钟偏差），仍归入同一周期，不新开
  if (gap < CYCLE_GAP_MS) {
    return {
      kind: 'ACCUMULATE',
      targetId: active.id,
      nextCount: active.count + incoming.count,
      nextLastSeen:
        incoming.lastSeen.getTime() > active.lastSeen.getTime()
          ? incoming.lastSeen
          : new Date(active.lastSeen),
    };
  }
  return { kind: 'NEW_CYCLE', expireId: active.id };
}

export type NormalizeInput = {
  fingerprintId: string;
  severity: Severity;
  value?: number | null;
  threshold?: number | null;
  message: string;
  count?: number;
  firstSeen: Date;
  lastSeen?: Date;
  externalKey?: string | null;
  raw?: Prisma.InputJsonValue;
};

export type NormalizeResult = {
  alertId: string;
  action: CycleAction;
  status: AlertStatus;
  /** 本次累加后的总次数（新建时为传入 count） */
  count: number;
};

/**
 * 归一化落库：先查活跃周期再决定累加还是新建。
 * 不靠唯一键异常做正常分支判断（否则每次去重都刷 prisma:error），P2002 只兜并发。
 */
export async function normalizeOccurrence(input: NormalizeInput): Promise<NormalizeResult> {
  const incoming = {
    firstSeen: input.firstSeen,
    lastSeen: input.lastSeen ?? input.firstSeen,
    count: input.count ?? 1,
  };

  const active = await db.alert.findFirst({
    where: { fingerprintId: input.fingerprintId, status: { in: ['ACTIVE', 'SUPPRESSED'] } },
    orderBy: { cycleStart: 'desc' },
    select: {
      id: true,
      status: true,
      severity: true,
      count: true,
      firstSeen: true,
      lastSeen: true,
    },
  });

  const decision = decideCycle(active, incoming);

  if (decision.kind === 'ACCUMULATE' && active) {
    const updated = await db.alert.update({
      where: { id: decision.targetId },
      data: {
        count: decision.nextCount,
        lastSeen: decision.nextLastSeen,
        // 同一周期内再报更严重时，周期取更严重的一档（P2 → P1 是真实的恶化）
        severity: maxSeverity(active.severity, input.severity),
        // 保留原 message 的"首次形态"更利于复盘，但值可能已变化 → 存最新值
        value: input.value ?? undefined,
        threshold: input.threshold ?? undefined,
      },
      select: { id: true, status: true, count: true },
    });
    return {
      alertId: updated.id,
      action: 'ACCUMULATED',
      status: updated.status,
      count: updated.count,
    };
  }

  const expireId = decision.kind === 'NEW_CYCLE' ? decision.expireId : null;
  if (expireId) {
    await db.alert.update({
      where: { id: expireId },
      data: { status: 'RESOLVED' },
    });
  }

  const cycleStart = toCycleStart(incoming.firstSeen);
  try {
    const created = await db.alert.create({
      data: {
        fingerprintId: input.fingerprintId,
        severity: input.severity,
        value: input.value ?? null,
        threshold: input.threshold ?? null,
        message: input.message,
        count: incoming.count,
        firstSeen: incoming.firstSeen,
        lastSeen: incoming.lastSeen,
        cycleStart,
        externalKey: input.externalKey ?? null,
        raw: input.raw,
      },
      select: { id: true, status: true, count: true },
    });
    return {
      alertId: created.id,
      action: expireId ? 'RESTARTED' : 'CREATED',
      status: created.status,
      count: created.count,
    };
  } catch (error) {
    // 并发下同一分钟同指纹撞唯一键：退化为累加到已存在的那条
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const existing = await db.alert.findUnique({
        where: { fingerprintId_cycleStart: { fingerprintId: input.fingerprintId, cycleStart } },
        select: { id: true, status: true, count: true },
      });
      if (existing) {
        const merged = await db.alert.update({
          where: { id: existing.id },
          data: { count: existing.count + incoming.count, lastSeen: incoming.lastSeen },
          select: { id: true, status: true, count: true },
        });
        return {
          alertId: merged.id,
          action: 'ACCUMULATED',
          status: merged.status,
          count: merged.count,
        };
      }
    }
    throw error;
  }
}

/** 关闭单个告警周期（设备恢复 / 人工确认） */
export async function resolveOccurrence(alertId: string): Promise<void> {
  await db.alert.updateMany({
    where: { id: alertId, status: { in: ['ACTIVE', 'SUPPRESSED'] } },
    data: { status: 'RESOLVED' },
  });
}
