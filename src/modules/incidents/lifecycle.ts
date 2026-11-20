import type { IncidentStatus, Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { createLogger } from '@/lib/logger';
import { buildCaseDraft, upsertCase } from '@/modules/case/service';
import { generateReport } from '@/modules/report/service';
import { parseClosure, parseStatusLog, type StatusLogEntry } from './closure-view';
import { getIncidentDetail } from './detail';
import { assertTransition } from './stateMachine';

/**
 * 人工确认与结案（T08 / F7 / AC-08 / AC-09）。
 *
 * 职责边界：
 * - 状态机只判"能不能走"，这里负责"走完之后写什么"（locatedAt / resolvedAt /
 *   mttrSeconds / statusLog / closure）。
 * - 结案的两个副作用（沉淀案例、生成报告）放在事务之外：状态必须先落库，
 *   报告生成失败不该把结案也回滚 —— 人已经把故障处理完了，系统不能因为
 *   一段 Markdown 没拼出来就说"结案失败"。
 *
 * 注意 reopenIncident（B6 自动重开）故意不经过这里：它是系统行为，
 * 需要把 RESOLVED 改回 OPEN，人工接口不提供这条路径（AC-08）。
 */

export type TransitionInput = {
  idOrCode: string;
  to: IncidentStatus;
  note?: string | null;
  now?: Date;
};

export type TransitionResult = {
  id: string;
  code: string;
  from: IncidentStatus;
  to: IncidentStatus;
  /** false 表示幂等命中（目标状态与当前一致） */
  changed: boolean;
  mttrSeconds: number | null;
  statusLog: StatusLogEntry[];
  reportId: string | null;
  caseId: string | null;
  warnings: string[];
};

const asJson = (value: unknown): Prisma.InputJsonValue => value as Prisma.InputJsonValue;

const logger = createLogger('incidents/lifecycle');

export async function transitionIncident(input: TransitionInput): Promise<TransitionResult | null> {
  const now = input.now ?? new Date();
  const note = input.note?.trim() ? input.note.trim() : null;

  const incident = await db.incident.findFirst({
    where: { OR: [{ id: input.idOrCode }, { code: input.idOrCode }] },
    select: {
      id: true,
      code: true,
      status: true,
      startedAt: true,
      locatedAt: true,
      resolvedAt: true,
      mttrSeconds: true,
      closedReason: true,
      statusLog: true,
      // 结案记录要写明采纳了哪条假设 —— 报告里"根因"段的出处
      hypotheses: {
        where: { verdict: 'ACCEPTED' },
        take: 1,
        select: { id: true, cause: true },
      },
    },
  });

  if (!incident) return null;

  const from = incident.status;
  const log = parseStatusLog(incident.statusLog);

  // 同状态视为幂等：前端重复点同一按钮不该报 409，但也别追加一条假日志
  if (from === input.to) {
    return {
      id: incident.id,
      code: incident.code,
      from,
      to: input.to,
      changed: false,
      mttrSeconds: incident.mttrSeconds,
      statusLog: log,
      reportId: null,
      caseId: null,
      warnings: [],
    };
  }

  assertTransition(from, input.to);

  const accepted = incident.hypotheses[0] ?? null;
  const entry: StatusLogEntry = { from, to: input.to, at: now.toISOString(), note };

  const data: Prisma.IncidentUncheckedUpdateInput = {
    status: input.to,
    statusLog: asJson([...log, entry]),
  };

  let resolvedAt: Date | null = incident.resolvedAt;
  let nextMttr = incident.mttrSeconds;
  if (input.to === 'LOCATED') {
    data.locatedAt = incident.locatedAt ?? now;
  }
  if (input.to === 'RESOLVED') {
    resolvedAt = incident.resolvedAt ?? now;
    nextMttr = Math.max(
      0,
      Math.round((resolvedAt.getTime() - incident.startedAt.getTime()) / 1000),
    );
    data.resolvedAt = resolvedAt;
    data.mttrSeconds = nextMttr;
    data.closedReason = 'MANUAL';
    data.closure = asJson({
      at: now.toISOString(),
      note,
      acceptedHypothesisId: accepted?.id ?? null,
      acceptedCause: accepted?.cause ?? null,
    });
  } else if (input.to === 'CLOSED') {
    // 归档不改 MTTR：从 RESOLVED 归档时 resolvedAt 已存在，这里只补 closedReason
    if (!incident.resolvedAt) resolvedAt = now;
    data.closedReason = incident.closedReason ?? 'MANUAL';
  }

  await db.incident.update({ where: { id: incident.id }, data });

  const result: TransitionResult = {
    id: incident.id,
    code: incident.code,
    from,
    to: input.to,
    changed: true,
    mttrSeconds: nextMttr,
    statusLog: [...log, entry],
    reportId: null,
    caseId: null,
    warnings: [],
  };

  if (input.to === 'RESOLVED') {
    const detail = await getIncidentDetail(incident.id);
    if (!detail) {
      result.warnings.push('事件读取失败，未生成案例与报告');
      return result;
    }

    const acceptedView = detail.hypotheses.find((h) => h.verdict === 'ACCEPTED') ?? null;

    // 评审第 3 阶段：结案前提示未完成验证项。不阻断 —— 人可能已经用别的方式
    // 确认过了，系统没有资格拦着不让结案；但如果一条都没验，这事必须说出来。
    const pendingSteps = acceptedView ? acceptedView.verify.total - acceptedView.verify.done : 0;
    if (pendingSteps > 0) {
      result.warnings.push(`采纳的根因还有 ${pendingSteps} 个验证步骤未勾选，报告里会照实记录`);
    }

    try {
      result.caseId = await upsertCase(detail.id, buildCaseDraft(detail, acceptedView));
    } catch (error) {
      logger.warn('结案沉淀案例失败', { err: String(error), incident: incident.code });
      result.warnings.push('案例沉淀失败，可在案例库中手动补录');
    }

    try {
      const report = await generateReport(detail.id, { now });
      result.reportId = report?.reportId ?? null;
    } catch (error) {
      logger.warn('结案生成报告失败', { err: String(error), incident: incident.code });
      result.warnings.push('报告生成失败，可在详情页重新生成');
    }

    logger.info('事件结案', {
      incident: incident.code,
      from,
      to: input.to,
      mttrSeconds: result.mttrSeconds,
      case: result.caseId !== null,
      report: result.reportId !== null,
    });
  }

  return result;
}

/**
 * 假设裁决（F7「采纳/否决某条假设」）。
 *
 * "采纳"是单选：先把同一事件其它 ACCEPTED 降为 null，再设置目标。
 * 一次故障只能有一个主根因，允许同时采纳两条等于没给结论。
 */
export type Verdict = 'ACCEPTED' | 'REJECTED' | null;

export type VerdictResult = {
  hypothesisId: string;
  incidentId: string;
  verdict: Verdict;
  acceptedHypothesisId: string | null;
};

export async function setHypothesisVerdict(input: {
  incidentIdOrCode: string;
  hypothesisId: string;
  verdict: Verdict;
  note?: string | null;
  now?: Date;
}): Promise<VerdictResult | null> {
  const now = input.now ?? new Date();
  const incident = await db.incident.findFirst({
    where: { OR: [{ id: input.incidentIdOrCode }, { code: input.incidentIdOrCode }] },
    select: { id: true },
  });
  if (!incident) return null;

  const hypothesis = await db.hypothesis.findFirst({
    where: { id: input.hypothesisId, incidentId: incident.id },
    select: { id: true },
  });
  if (!hypothesis) return null;

  await db.$transaction(async (tx) => {
    if (input.verdict === 'ACCEPTED') {
      await tx.hypothesis.updateMany({
        where: { incidentId: incident.id, verdict: 'ACCEPTED', id: { not: hypothesis.id } },
        data: { verdict: null, verdictAt: null, verdictNote: null },
      });
    }
    await tx.hypothesis.update({
      where: { id: hypothesis.id },
      data: {
        verdict: input.verdict,
        verdictAt: input.verdict ? now : null,
        verdictNote: input.verdict ? input.note?.trim() || null : null,
      },
    });
  });

  const accepted = await db.hypothesis.findFirst({
    where: { incidentId: incident.id, verdict: 'ACCEPTED' },
    select: { id: true },
  });

  return {
    hypothesisId: hypothesis.id,
    incidentId: incident.id,
    verdict: input.verdict,
    acceptedHypothesisId: accepted?.id ?? null,
  };
}

/** 结案记录读取（API/报告复用；页面走 getIncidentDetail 已带） */
export async function getClosure(idOrCode: string) {
  const incident = await db.incident.findFirst({
    where: { OR: [{ id: idOrCode }, { code: idOrCode }] },
    select: { closure: true },
  });
  return incident ? parseClosure(incident.closure) : null;
}
