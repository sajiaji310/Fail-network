import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { findDevice, loadDevices } from '@/modules/ingest/resolve';

/**
 * 指标快照（评审第 4 阶段「引入指标快照或时序数据，避免只依赖告警瞬时值」）。
 *
 * 存的是**采样点**，不是告警快照：告警里的 value/threshold 只说明"上报那一刻超了多少"，
 * 判断"是持续爬升还是瞬间尖刺"必须看前后几分钟的曲线。
 *
 * 三个约束：
 * 1. 幂等靠唯一键 (deviceId, metric, at, source)：上游重推同一时刻的采样不会把曲线拉高；
 * 2. 只保留窗口内需要的点：写入时不校验窗口，由保留策略按天清理（`retention.metricDays`）；
 * 3. 趋势计算在内存里做：一次研判要看的点量级在几十到几百，拉回来算比写 SQL 窗口函数
 *    更直观，也不依赖 PG 版本。
 */

export type MetricInput = {
  deviceName: string;
  metric: string;
  value: number;
  unit?: string | null;
  at: Date;
  source?: string;
  labels?: Record<string, unknown> | null;
};

export type MetricPushResult = {
  accepted: number;
  skipped: number;
  issues: { deviceName?: string; message: string }[];
};

export type MetricPoint = { at: string; value: number };

export type MetricTrend = {
  /** 采样点数 */
  samples: number;
  first: number;
  last: number;
  min: number;
  max: number;
  /** 每分钟变化量：正=上升，负=下降；两点以下为 0 */
  slopePerMin: number;
  from: string;
  to: string;
};

export function summarizeTrend(points: readonly MetricPoint[]): MetricTrend | null {
  if (points.length === 0) return null;
  const sorted = [...points].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  let min = first.value;
  let max = first.value;
  for (const point of sorted) {
    if (point.value < min) min = point.value;
    if (point.value > max) max = point.value;
  }
  const spanMs = new Date(last.at).getTime() - new Date(first.at).getTime();
  const slopePerMin =
    sorted.length < 2 || spanMs <= 0
      ? 0
      : Math.round(((last.value - first.value) / (spanMs / 60_000)) * 1000) / 1000;

  return {
    samples: sorted.length,
    first: first.value,
    last: last.value,
    min,
    max,
    slopePerMin,
    from: first.at,
    to: last.at,
  };
}

/** 批量写入。设备按 别名→名→IP 解析，与告警导入同一套规则 */
export async function recordSamples(
  inputs: readonly MetricInput[],
  tenantId = 'default',
): Promise<MetricPushResult> {
  const result: MetricPushResult = { accepted: 0, skipped: 0, issues: [] };
  if (inputs.length === 0) return result;

  const lookup = await loadDevices(tenantId);
  const rows: {
    deviceId: string;
    metric: string;
    value: number;
    unit: string | null;
    at: Date;
    source: string;
    labels: Prisma.InputJsonValue | undefined;
    tenantId: string;
  }[] = [];

  for (const input of inputs) {
    const device = findDevice(lookup, input.deviceName);
    if (!device) {
      result.skipped++;
      if (result.issues.length < 50) {
        result.issues.push({
          deviceName: input.deviceName,
          message: `设备不存在：${input.deviceName}`,
        });
      }
      continue;
    }
    rows.push({
      deviceId: device.id,
      metric: input.metric,
      value: input.value,
      unit: input.unit ?? null,
      at: input.at,
      source: input.source ?? 'push',
      labels: (input.labels ?? undefined) as Prisma.InputJsonValue | undefined,
      tenantId,
    });
  }

  if (rows.length > 0) {
    // skipDuplicates 要求 PostgreSQL，本地就是；换成其他库时要改成逐条 upsert
    const created = await db.metricSample.createMany({ data: rows, skipDuplicates: true });
    result.accepted = created.count;
    result.skipped += rows.length - created.count;
  }
  return result;
}

export type MetricQuery = {
  deviceId?: string;
  deviceName?: string;
  metric?: string;
  from?: Date;
  to?: Date;
  limit?: number;
  tenantId?: string;
};

export async function querySamples(query: MetricQuery): Promise<{
  points: {
    deviceId: string;
    deviceName: string;
    metric: string;
    value: number;
    unit: string | null;
    at: string;
    source: string;
  }[];
  total: number;
}> {
  const limit = Math.min(2000, Math.max(1, query.limit ?? 500));
  let deviceId = query.deviceId;
  if (!deviceId && query.deviceName) {
    const device = await db.device.findFirst({
      where: {
        name: { equals: query.deviceName, mode: 'insensitive' },
        ...(query.tenantId ? { tenantId: query.tenantId } : {}),
      },
      select: { id: true },
    });
    deviceId = device?.id;
    if (!deviceId) return { points: [], total: 0 };
  }

  const rows = await db.metricSample.findMany({
    where: {
      ...(deviceId ? { deviceId } : {}),
      ...(query.metric ? { metric: query.metric } : {}),
      ...(query.tenantId ? { tenantId: query.tenantId } : {}),
      ...(query.from || query.to
        ? {
            at: {
              ...(query.from ? { gte: query.from } : {}),
              ...(query.to ? { lte: query.to } : {}),
            },
          }
        : {}),
    },
    orderBy: { at: 'desc' },
    take: limit,
    select: {
      deviceId: true,
      metric: true,
      value: true,
      unit: true,
      at: true,
      source: true,
      device: { select: { name: true } },
    },
  });

  return {
    points: rows.map((row) => ({
      deviceId: row.deviceId,
      deviceName: row.device.name,
      metric: row.metric,
      value: row.value,
      unit: row.unit,
      at: row.at.toISOString(),
      source: row.source,
    })),
    total: rows.length,
  };
}

/**
 * 事件窗口内按 设备+指标 聚合趋势，供 RCA 上下文使用。
 * 一次查询取回窗口内所有采样，再在内存里分组 —— 避免"每台设备一个查询"的 N+1。
 */
export async function loadTrends(
  deviceIds: readonly string[],
  from: Date,
  to: Date,
  maxSamples = 5000,
): Promise<Map<string, MetricTrend & { unit: string | null; deviceId: string; metric: string }>> {
  const trends = new Map<
    string,
    MetricTrend & { unit: string | null; deviceId: string; metric: string }
  >();
  if (deviceIds.length === 0) return trends;

  const rows = await db.metricSample.findMany({
    where: { deviceId: { in: [...deviceIds] }, at: { gte: from, lte: to } },
    orderBy: { at: 'asc' },
    take: maxSamples,
    select: { deviceId: true, metric: true, value: true, unit: true, at: true },
  });

  const grouped = new Map<
    string,
    { deviceId: string; metric: string; unit: string | null; points: MetricPoint[] }
  >();
  for (const row of rows) {
    const key = `${row.deviceId}|${row.metric}`;
    const entry = grouped.get(key) ?? {
      deviceId: row.deviceId,
      metric: row.metric,
      unit: row.unit,
      points: [],
    };
    entry.points.push({ at: row.at.toISOString(), value: row.value });
    grouped.set(key, entry);
  }

  for (const [key, entry] of grouped) {
    const trend = summarizeTrend(entry.points);
    if (!trend) continue;
    trends.set(key, {
      ...trend,
      deviceId: entry.deviceId,
      metric: entry.metric,
      unit: entry.unit,
    });
  }
  return trends;
}

export function metricRef(deviceName: string, metric: string): string {
  return `metric:${deviceName}:${metric}`;
}
