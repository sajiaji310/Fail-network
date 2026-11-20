import type { Prisma, Severity } from '@prisma/client';
import { db } from '@/lib/db';
import { AppError } from '@/lib/errors';
import { clusterKeyOf } from '@/modules/alerts/fingerprint';
import {
  maxSeverity,
  nextIncidentCode,
  refreshIncidentAggregate,
} from '@/modules/correlation/persist';
import { parseStatusLog } from './closure-view';
import { slaMinutesOf } from './sla';

/**
 * 事件拆分（评审第 2 阶段「事件拆分的人工操作入口」）。
 *
 * 自动聚合一定会有判错的时候：两条告警共享设备、时间也挨着，但其实是两回事
 * （例如换线导致的 Down 和原故障的余波）。没有拆分入口，用户只能接受错误事件，
 * 或者去数据库里改 —— 前者会毁掉复盘材料，后者会毁掉审计。
 *
 * 三条约束：
 * 1. **不能把事件拆空**：至少给原事件留一条告警，否则原事件就成了没有证据的空壳。
 * 2. **拆分是显式决定**：新事件的 clusterKey 带 `split:` 盐，且 `splitFromId` 指向原事件，
 *    聚合的合并阶段会跳过这对组合，不会下一轮又悄悄并回去。
 * 3. **两边都留痕**：原事件 statusLog 追加一条记录，新事件带 splitFromId，审计表另有一条。
 */

export type SplitResult = {
  source: { id: string; code: string; alertCount: number };
  target: { id: string; code: string; alertCount: number };
  moved: number;
};

const asJson = (value: unknown): Prisma.InputJsonValue => value as Prisma.InputJsonValue;

const SEVERITY_RANK: Record<Severity, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

export type SplitInput = {
  idOrCode: string;
  alertIds: readonly string[];
  note?: string | null;
  now?: Date;
};

export async function splitIncident(input: SplitInput): Promise<SplitResult | null> {
  const now = input.now ?? new Date();
  const wanted = [...new Set(input.alertIds)];
  if (wanted.length === 0) {
    throw new AppError('VALIDATION_FAILED', '至少选择一条告警');
  }

  const incident = await db.incident.findFirst({
    where: { OR: [{ id: input.idOrCode }, { code: input.idOrCode }] },
    select: {
      id: true,
      code: true,
      status: true,
      severity: true,
      statusLog: true,
      alerts: {
        select: {
          id: true,
          severity: true,
          firstSeen: true,
          lastSeen: true,
          fingerprintId: true,
          fingerprint: {
            select: { deviceId: true, type: true, device: { select: { name: true } } },
          },
        },
      },
    },
  });
  if (!incident) return null;
  if (incident.status === 'RESOLVED' || incident.status === 'CLOSED') {
    throw new AppError('INVALID_TRANSITION', '已结案的事件不能再拆分，请先重开');
  }

  const byId = new Map(incident.alerts.map((a) => [a.id, a]));
  const unknown = wanted.filter((id) => !byId.has(id));
  if (unknown.length > 0) {
    throw new AppError(
      'VALIDATION_FAILED',
      `有 ${unknown.length} 条告警不属于该事件，未执行拆分`,
      unknown.slice(0, 5).map((id) => `alertId: ${id}`),
    );
  }
  if (wanted.length >= incident.alerts.length) {
    throw new AppError('VALIDATION_FAILED', '不能把全部告警都拆走，原事件至少保留 1 条');
  }

  const moved = wanted.map((id) => byId.get(id)!);
  const firstSeen = moved.reduce(
    (min, a) => (a.firstSeen < min ? a.firstSeen : min),
    moved[0]!.firstSeen,
  );
  const lastSeen = moved.reduce(
    (max, a) => (a.lastSeen > max ? a.lastSeen : max),
    moved[0]!.lastSeen,
  );
  const severity = maxSeverity(moved.map((a) => a.severity));
  const primary = [...moved].sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || +a.firstSeen - +b.firstSeen,
  )[0]!;
  const deviceCount = new Set(moved.map((a) => a.fingerprint.deviceId)).size;
  const title =
    deviceCount > 1
      ? `${primary.fingerprint.device.name} ${primary.fingerprint.type}（拆分，波及 ${deviceCount} 台设备）`
      : `${primary.fingerprint.device.name} ${primary.fingerprint.type}（人工拆分）`;

  // 带 split: 盐：即便指纹集合与原事件不同，也避免与自动聚合生成的 key 撞车
  const clusterKey = clusterKeyOf([...moved.map((a) => a.fingerprintId), `split:${incident.id}`]);
  const code = await nextIncidentCode(firstSeen);
  const note = input.note?.trim() ? input.note.trim() : null;

  const target = await db.$transaction(async (tx) => {
    const created = await tx.incident.create({
      data: {
        code,
        title,
        status: 'OPEN',
        severity,
        startedAt: firstSeen,
        lastSeen,
        clusterKey,
        splitFromId: incident.id,
        // 与自动聚合创建的事件保持同一口径：响应目标在创建时快照
        slaMinutes: slaMinutesOf({ severity, slaMinutes: null }),
      },
      select: { id: true, code: true },
    });

    await tx.alert.updateMany({
      where: { id: { in: wanted } },
      data: { incidentId: created.id },
    });

    const log = parseStatusLog(incident.statusLog);
    await tx.incident.update({
      where: { id: incident.id },
      data: {
        statusLog: asJson([
          ...log,
          {
            from: incident.status,
            to: incident.status,
            at: now.toISOString(),
            note: note
              ? `拆分 ${wanted.length} 条告警到 ${created.code}：${note}`
              : `拆分 ${wanted.length} 条告警到 ${created.code}`,
          },
        ]),
      },
    });

    return created;
  });

  // 聚合字段重算放在事务外：拆分本身已经成立，聚合算错不该回滚人工决定
  await Promise.all([refreshIncidentAggregate(incident.id), refreshIncidentAggregate(target.id)]);

  const [sourceCount, targetCount] = await Promise.all([
    db.alert.count({ where: { incidentId: incident.id } }),
    db.alert.count({ where: { incidentId: target.id } }),
  ]);

  return {
    source: { id: incident.id, code: incident.code, alertCount: sourceCount },
    target: { id: target.id, code: target.code, alertCount: targetCount },
    moved: wanted.length,
  };
}
