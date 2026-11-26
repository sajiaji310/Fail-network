import { Prisma, type AlertStatus, type Severity } from '@prisma/client';
import { db } from '@/lib/db';
import { signatureOf } from './fingerprint';
import { decideCycle, maxSeverity, toCycleStart, type ActiveOccurrence } from './normalize';
import { findActiveParent, suppressByParent } from './suppress';
import { classifyAlertType, PARENT_ALERT_TYPES, type AlertClass } from './taxonomy';
import { recordAlert, type RecordAlertInput, type RecordOutcome } from './service';

/**
 * 一批告警的归一化写路径。
 *
 * 逐行 `recordAlert` 每次都要：指纹 upsert、查活跃周期、插入、再查父告警。
 * 回填时这几步占掉几乎全部时间。这里改成：
 * 1. 指纹和活跃周期各查一次；
 * 2. 按输入顺序在内存里走 30 分钟周期（不能按时间重排，乱序补报要和逐行一致）；
 * 3. 过期、累加、新建分组写入；
 * 4. 抑制仍按输入顺序走。同批里后到的行，对前面的父告警不可见。
 *
 * 并发撞上唯一键时，事务回滚，整批退回逐行 `recordAlert`。
 */

type CycleState = {
  id: string | null;
  creatorIndex: number | null;
  status: AlertStatus;
  severity: Severity;
  count: number;
  firstSeen: Date;
  lastSeen: Date;
  type: string;
};

type CreatePlan = {
  creatorIndex: number;
  fingerprintId: string;
  tenantId: string;
  severity: Severity;
  value: number | null;
  threshold: number | null;
  message: string;
  count: number;
  firstSeen: Date;
  lastSeen: Date;
  cycleStart: Date;
  externalKey: string | null;
  raw: Prisma.InputJsonValue;
  resolved: boolean;
};

type UpdatePlan = {
  id: string;
  count: number;
  lastSeen: Date;
  severity: Severity;
  value: number | null | undefined;
  threshold: number | null | undefined;
};

type Planned = {
  index: number;
  action: RecordOutcome['action'];
  kind: AlertClass;
  deviceId: string;
  alertId: string | null;
  creatorIndex: number | null;
  status: AlertStatus;
  firstSeen: Date;
  /** 这一行在本批的哪个下标被新周期关掉。没被关掉就是无穷大 */
  visibleUntil: number;
};

function cycleKey(fingerprintId: string, tenantId: string): string {
  return `${fingerprintId}\0${tenantId}`;
}

function toActive(state: CycleState | null): ActiveOccurrence | null {
  if (!state) return null;
  return {
    id: state.id ?? `pending:${state.creatorIndex}`,
    status: state.status,
    severity: state.severity,
    count: state.count,
    firstSeen: state.firstSeen,
    lastSeen: state.lastSeen,
  };
}

export async function recordAlerts(
  items: readonly RecordAlertInput[],
  now: Date = new Date(),
): Promise<RecordOutcome[]> {
  if (items.length === 0) return [];
  try {
    return await recordAlertsGrouped(items, now);
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
      throw error;
    }
    const outcomes: RecordOutcome[] = [];
    for (const item of items) outcomes.push(await recordAlert(item, now));
    return outcomes;
  }
}

async function recordAlertsGrouped(
  items: readonly RecordAlertInput[],
  now: Date,
): Promise<RecordOutcome[]> {
  const signatures = items.map((item) => signatureOf(item.deviceId, item.type, item.metric));
  const idBySignature = await loadFingerprints(items, signatures);
  const fingerprintIds = [...new Set(signatures.map((signature) => idBySignature.get(signature)!))];
  const tenantIds = [...new Set(items.map((item) => item.tenantId ?? 'default'))];

  const activeRows = await db.alert.findMany({
    where: {
      fingerprintId: { in: fingerprintIds },
      tenantId: { in: tenantIds },
      status: { in: ['ACTIVE', 'SUPPRESSED'] },
    },
    orderBy: { cycleStart: 'desc' },
    select: {
      id: true,
      fingerprintId: true,
      tenantId: true,
      status: true,
      severity: true,
      count: true,
      firstSeen: true,
      lastSeen: true,
      fingerprint: { select: { type: true } },
    },
  });

  const cycles = new Map<string, CycleState>();
  for (const row of activeRows) {
    const key = cycleKey(row.fingerprintId, row.tenantId);
    if (cycles.has(key)) continue;
    cycles.set(key, {
      id: row.id,
      creatorIndex: null,
      status: row.status,
      severity: row.severity,
      count: row.count,
      firstSeen: row.firstSeen,
      lastSeen: row.lastSeen,
      type: row.fingerprint.type,
    });
  }

  const creates: CreatePlan[] = [];
  const updates = new Map<string, UpdatePlan>();
  const expireIds = new Set<string>();
  const expiredParents: ParentWindow[] = [];
  const planned: Planned[] = [];

  for (let index = 0; index < items.length; index++) {
    const item = items[index]!;
    const tenantId = item.tenantId ?? 'default';
    const fingerprintId = idBySignature.get(signatures[index]!)!;
    const key = cycleKey(fingerprintId, tenantId);
    const incoming = {
      firstSeen: item.firstSeen,
      lastSeen: item.lastSeen ?? item.firstSeen,
      count: item.count ?? 1,
    };
    const current = cycles.get(key) ?? null;
    const decision = decideCycle(toActive(current), incoming);
    const kind = classifyAlertType(item.type);

    if (decision.kind === 'ACCUMULATE' && current) {
      current.count = decision.nextCount;
      current.lastSeen = decision.nextLastSeen;
      current.severity = maxSeverity(current.severity, item.severity);
      if (current.id) {
        const prev = updates.get(current.id);
        updates.set(current.id, {
          id: current.id,
          count: current.count,
          lastSeen: current.lastSeen,
          severity: current.severity,
          value: item.value ?? prev?.value,
          threshold: item.threshold ?? prev?.threshold,
        });
      } else if (current.creatorIndex !== null) {
        const created = creates.find((row) => row.creatorIndex === current.creatorIndex);
        if (created) {
          created.count = current.count;
          created.lastSeen = current.lastSeen;
          created.severity = current.severity;
          if (item.value != null) created.value = item.value;
          if (item.threshold != null) created.threshold = item.threshold;
        }
      }
      planned.push({
        index,
        action: 'ACCUMULATED',
        kind,
        deviceId: item.deviceId,
        alertId: current.id,
        creatorIndex: current.creatorIndex,
        status: current.status,
        firstSeen: current.firstSeen,
        visibleUntil: Number.POSITIVE_INFINITY,
      });
      continue;
    }

    if (current?.id) {
      expireIds.add(current.id);
      if (classifyAlertType(current.type) === 'PARENT') {
        expiredParents.push({
          deviceId: item.deviceId,
          id: current.id,
          firstSeen: current.firstSeen,
          lastSeen: current.lastSeen,
          arrival: -1,
          visibleUntil: index,
        });
      }
    }
    if (current?.creatorIndex !== null && current?.creatorIndex !== undefined) {
      const created = creates.find((row) => row.creatorIndex === current.creatorIndex);
      if (created) created.resolved = true;
      const opened = planned.find((row) => row.index === current.creatorIndex);
      if (opened) opened.visibleUntil = index;
    }

    const cycleStart = toCycleStart(incoming.firstSeen);
    creates.push({
      creatorIndex: index,
      fingerprintId,
      tenantId,
      severity: item.severity,
      value: item.value ?? null,
      threshold: item.threshold ?? null,
      message: item.message,
      count: incoming.count,
      firstSeen: incoming.firstSeen,
      lastSeen: incoming.lastSeen,
      cycleStart,
      externalKey: item.externalKey ?? null,
      raw: { source: item.source, ...(item.raw ?? {}) } as Prisma.InputJsonValue,
      resolved: false,
    });
    cycles.set(key, {
      id: null,
      creatorIndex: index,
      status: 'ACTIVE',
      severity: item.severity,
      count: incoming.count,
      firstSeen: incoming.firstSeen,
      lastSeen: incoming.lastSeen,
      type: item.type,
    });
    planned.push({
      index,
      action: decision.kind === 'NEW_CYCLE' && decision.expireId ? 'RESTARTED' : 'CREATED',
      kind,
      deviceId: item.deviceId,
      alertId: null,
      creatorIndex: index,
      status: 'ACTIVE',
      firstSeen: incoming.firstSeen,
      visibleUntil: Number.POSITIVE_INFINITY,
    });
  }

  const createdIds = await db.$transaction(
    async (tx) => {
      if (expireIds.size > 0) {
        await tx.alert.updateMany({
          where: { id: { in: [...expireIds] } },
          data: { status: 'RESOLVED' },
        });
      }
      for (const update of updates.values()) {
        if (expireIds.has(update.id)) continue;
        await tx.alert.update({
          where: { id: update.id },
          data: {
            count: update.count,
            lastSeen: update.lastSeen,
            severity: update.severity,
            value: update.value ?? undefined,
            threshold: update.threshold ?? undefined,
          },
        });
      }
      for (const id of expireIds) {
        const update = updates.get(id);
        if (!update) continue;
        await tx.alert.update({
          where: { id },
          data: {
            status: 'RESOLVED',
            count: update.count,
            lastSeen: update.lastSeen,
            severity: update.severity,
            value: update.value ?? undefined,
            threshold: update.threshold ?? undefined,
          },
        });
      }
      if (creates.length === 0) return new Map<number, string>();
      const rows = await tx.alert.createManyAndReturn({
        data: creates.map((row) => ({
          fingerprintId: row.fingerprintId,
          tenantId: row.tenantId,
          severity: row.severity,
          value: row.value,
          threshold: row.threshold,
          message: row.message,
          count: row.count,
          firstSeen: row.firstSeen,
          lastSeen: row.lastSeen,
          cycleStart: row.cycleStart,
          externalKey: row.externalKey,
          raw: row.raw,
          status: row.resolved ? 'RESOLVED' : 'ACTIVE',
        })),
        select: { id: true, fingerprintId: true, cycleStart: true },
      });
      const byCycle = new Map(
        rows.map((row) => [`${row.fingerprintId}|${row.cycleStart.getTime()}`, row.id]),
      );
      const ids = new Map<number, string>();
      for (const row of creates) {
        const id = byCycle.get(`${row.fingerprintId}|${row.cycleStart.getTime()}`);
        if (!id) throw new Error('批量写入后找不到新建告警');
        ids.set(row.creatorIndex, id);
      }
      return ids;
    },
    { timeout: 30_000 },
  );

  for (const row of planned) {
    if (!row.alertId && row.creatorIndex !== null) {
      row.alertId = createdIds.get(row.creatorIndex) ?? null;
    }
    if (row.alertId && expireIds.has(row.alertId)) row.status = 'RESOLVED';
    const created = creates.find((item) => item.creatorIndex === row.creatorIndex);
    if (created?.resolved) row.status = 'RESOLVED';
  }

  return applySuppression(planned, expiredParents, now);
}

async function loadFingerprints(
  items: readonly RecordAlertInput[],
  signatures: readonly string[],
): Promise<Map<string, string>> {
  const unique = [...new Set(signatures)];
  const known = await db.alertFingerprint.findMany({
    where: { signature: { in: unique } },
    select: { id: true, signature: true },
  });
  const idBySignature = new Map(known.map((row) => [row.signature, row.id]));
  const missing: Prisma.AlertFingerprintCreateManyInput[] = [];
  const queued = new Set<string>();
  for (let i = 0; i < items.length; i++) {
    const signature = signatures[i]!;
    if (idBySignature.has(signature) || queued.has(signature)) continue;
    queued.add(signature);
    const item = items[i]!;
    missing.push({
      signature,
      deviceId: item.deviceId,
      type: item.type,
      metric: item.metric ?? null,
      severity: item.severity,
    });
  }
  if (missing.length === 0) return idBySignature;
  await db.alertFingerprint.createMany({ data: missing, skipDuplicates: true });
  const created = await db.alertFingerprint.findMany({
    where: { signature: { in: [...queued] } },
    select: { id: true, signature: true },
  });
  for (const row of created) idBySignature.set(row.signature, row.id);
  return idBySignature;
}

type ParentWindow = {
  deviceId: string;
  id: string;
  firstSeen: Date;
  lastSeen: Date;
  arrival: number;
  visibleUntil: number;
};

async function applySuppression(
  planned: readonly Planned[],
  expiredParents: readonly ParentWindow[],
  now: Date,
): Promise<RecordOutcome[]> {
  const arrival = new Map<string, number>();
  for (const row of planned) {
    if (!row.alertId || row.creatorIndex === null) continue;
    const prev = arrival.get(row.alertId);
    if (prev === undefined || row.creatorIndex < prev) arrival.set(row.alertId, row.creatorIndex);
  }

  const deviceIds = [...new Set(planned.map((row) => row.deviceId))];
  const storedParents = await db.alert.findMany({
    where: {
      status: 'ACTIVE',
      fingerprint: { deviceId: { in: deviceIds }, type: { in: [...PARENT_ALERT_TYPES] } },
    },
    select: {
      id: true,
      firstSeen: true,
      lastSeen: true,
      fingerprint: { select: { deviceId: true } },
    },
  });

  const parentsByDevice = new Map<string, ParentWindow[]>();
  const addParent = (hit: ParentWindow) => {
    const list = parentsByDevice.get(hit.deviceId) ?? [];
    if (list.some((item) => item.id === hit.id && item.arrival === hit.arrival)) return;
    list.push(hit);
    parentsByDevice.set(hit.deviceId, list);
  };

  for (const row of storedParents) {
    const opened = planned.find((item) => item.alertId === row.id && item.kind === 'PARENT');
    addParent({
      deviceId: row.fingerprint.deviceId,
      id: row.id,
      firstSeen: row.firstSeen,
      lastSeen: row.lastSeen,
      arrival: arrival.get(row.id) ?? -1,
      visibleUntil: opened?.visibleUntil ?? Number.POSITIVE_INFINITY,
    });
  }
  for (const row of expiredParents) addParent(row);
  for (const row of planned) {
    if (row.kind !== 'PARENT' || !row.alertId || row.action === 'ACCUMULATED') continue;
    addParent({
      deviceId: row.deviceId,
      id: row.alertId,
      firstSeen: row.firstSeen,
      lastSeen: row.firstSeen,
      arrival: row.index,
      visibleUntil: row.visibleUntil,
    });
  }

  const outcomes: RecordOutcome[] = planned.map((row) => ({
    alertId: row.alertId ?? '',
    action: row.action,
    status: row.status,
    suppressed: false,
    retroSuppressed: 0,
    autoClosedIncidents: 0,
  }));
  const childUpdates = new Map<string, string[]>();

  for (const row of planned) {
    const outcome = outcomes[row.index]!;
    if (!row.alertId) continue;

    if (row.kind === 'PARENT') {
      const later = new Set(
        [...arrival.entries()].filter(([, at]) => at > row.index).map(([id]) => id),
      );
      const suppressed = await suppressByParent(row.alertId, now, later);
      outcome.retroSuppressed = suppressed.suppressedAlertIds.length;
      outcome.autoClosedIncidents = suppressed.affectedIncidents.filter(
        (item) => item.closed,
      ).length;
      continue;
    }

    if (row.kind !== 'CHILD' || row.action === 'ACCUMULATED' || row.status !== 'ACTIVE') continue;
    const known = parentsByDevice.get(row.deviceId) ?? [];
    const picked = pickParent(known, row.index);
    const parent = picked ?? (await loadFallbackParent(row.deviceId, known, row.index));
    if (!parent) continue;
    const bucket = childUpdates.get(parent.id) ?? [];
    bucket.push(row.alertId);
    childUpdates.set(parent.id, bucket);
    outcome.suppressed = true;
    outcome.status = 'SUPPRESSED';
  }

  for (const [parentId, ids] of childUpdates) {
    await db.alert.updateMany({
      where: { id: { in: ids }, status: 'ACTIVE' },
      data: { status: 'SUPPRESSED', suppressedByAlertId: parentId },
    });
  }

  return outcomes;
}

async function loadFallbackParent(
  deviceId: string,
  known: readonly ParentWindow[],
  index: number,
): Promise<ParentWindow | null> {
  const future = new Set(known.filter((item) => item.arrival >= index).map((item) => item.id));
  const fromDb = await findActiveParent(deviceId, db, future);
  if (!fromDb) return null;
  return {
    deviceId,
    id: fromDb.id,
    firstSeen: fromDb.firstSeen,
    lastSeen: fromDb.firstSeen,
    arrival: -1,
    visibleUntil: Number.POSITIVE_INFINITY,
  };
}

function pickParent(parents: readonly ParentWindow[], index: number): ParentWindow | null {
  let best: (typeof parents)[number] | null = null;
  for (const parent of parents) {
    if (parent.arrival >= index || index >= parent.visibleUntil) continue;
    if (!best || parent.lastSeen.getTime() > best.lastSeen.getTime()) best = parent;
  }
  return best;
}
