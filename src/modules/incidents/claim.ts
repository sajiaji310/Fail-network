import type { IncidentStatus, Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { AppError } from '@/lib/errors';
import { slaMinutesOf } from './sla';

/**
 * 接手与转派（评审 5.3「处理流程需要接手动作」）。
 *
 * 三个刻意的决定：
 * 1. **接手不改状态**。状态描述的是故障阶段，责任人描述的是谁在管 ——
 *    把两者绑在一起会出现"换个值班人就等于重新分析"的假记录。
 * 2. **抢单要拦**。已被别人接手时默认 409 + 当前责任人，而不是默默覆盖：
 *    "大家都看到了，但没人负责"的反面是"两个人都以为自己在负责"，
 *    后者更危险。确需交接时显式 force。
 * 3. **只写 claimedAt 一次**。第一次接手记响应耗时；转派不重置它，
 *    否则换个人 MTTA 就归零，统计就没意义了。
 */

export type ClaimInput = {
  idOrCode: string;
  assignee: string;
  team?: string | null;
  note?: string | null;
  /** 允许覆盖他人已接手的事件（转派） */
  force?: boolean;
  now?: Date;
  tenantId?: string;
};

export type ClaimResult = {
  id: string;
  code: string;
  assignee: string;
  team: string | null;
  claimedAt: string;
  /** 上一任责任人，首次接手为 null */
  previousAssignee: string | null;
  /** 本次接手耗时（秒）；转派时为原值，不重算 */
  claimSeconds: number;
  /** 是否在响应时限内接手 */
  withinSla: boolean;
};

const CLOSED: readonly IncidentStatus[] = ['RESOLVED', 'CLOSED'];

const SELECT = {
  id: true,
  code: true,
  status: true,
  severity: true,
  startedAt: true,
  assignee: true,
  team: true,
  claimedAt: true,
  slaMinutes: true,
} as const;

export async function claimIncident(input: ClaimInput): Promise<ClaimResult | null> {
  const now = input.now ?? new Date();
  const assignee = input.assignee.trim();
  if (!assignee) throw new AppError('VALIDATION_FAILED', '接手人不能为空');

  const incident = await db.incident.findFirst({
    where: {
      tenantId: input.tenantId ?? 'default',
      OR: [{ id: input.idOrCode }, { code: input.idOrCode }],
    },
    select: SELECT,
  });
  if (!incident) return null;

  if (CLOSED.includes(incident.status)) {
    throw new AppError('INCIDENT_CLOSED', `事件 ${incident.code} 已结束，不能再变更处理人`, {
      status: incident.status,
    });
  }

  const previous = incident.assignee;
  if (previous && previous !== assignee && !input.force) {
    throw new AppError('ALREADY_CLAIMED', `事件已由 ${previous} 接手，如需转派请确认`, {
      assignee: previous,
      team: incident.team,
      claimedAt: incident.claimedAt?.toISOString() ?? null,
    });
  }

  // 首次接手才写 claimedAt：转派不重置响应耗时
  const claimedAt = incident.claimedAt ?? now;
  const claimSeconds = Math.max(
    0,
    Math.round((claimedAt.getTime() - incident.startedAt.getTime()) / 1000),
  );
  const slaMinutes = slaMinutesOf(incident);

  const data: Prisma.IncidentUpdateInput = {
    assignee,
    team: input.team?.trim() ? input.team.trim() : incident.team,
    claimedAt,
    slaMinutes: incident.slaMinutes ?? slaMinutes,
  };
  await db.incident.update({ where: { id: incident.id }, data });

  return {
    id: incident.id,
    code: incident.code,
    assignee,
    team: (data.team as string | null | undefined) ?? incident.team,
    claimedAt: claimedAt.toISOString(),
    previousAssignee: previous,
    claimSeconds,
    withinSla: claimSeconds <= slaMinutes * 60,
  };
}

export type ReleaseResult = {
  id: string;
  code: string;
  releasedAssignee: string | null;
};

/**
 * 释放事件（交回队列）。
 *
 * 保留 claimedAt：响应已经发生过，抹掉它等于把一次超时洗成"从没人管"。
 */
export async function releaseIncident(input: {
  idOrCode: string;
  now?: Date;
  tenantId?: string;
}): Promise<ReleaseResult | null> {
  const incident = await db.incident.findFirst({
    where: {
      tenantId: input.tenantId ?? 'default',
      OR: [{ id: input.idOrCode }, { code: input.idOrCode }],
    },
    select: { id: true, code: true, status: true, assignee: true },
  });
  if (!incident) return null;

  if (CLOSED.includes(incident.status)) {
    throw new AppError('INCIDENT_CLOSED', `事件 ${incident.code} 已结束，无需释放`);
  }
  if (!incident.assignee) {
    // 幂等：本来没人接手，释放就是空操作
    return { id: incident.id, code: incident.code, releasedAssignee: null };
  }

  await db.incident.update({
    where: { id: incident.id },
    data: { assignee: null, team: null },
  });

  return { id: incident.id, code: incident.code, releasedAssignee: incident.assignee };
}
