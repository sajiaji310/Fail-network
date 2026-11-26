import { z } from 'zod';
import type { ParseIssue, ParseResult, RawAlert } from '../schema';
import { classifyAlertName, numberFromAnnotations, pickInstanceLabel, stripPort } from './classify';

/**
 * Prometheus Alertmanager webhook（v4）适配器。
 *
 * 现实约束：
 * - Alertmanager 的 `endsAt` 在 firing 时是 `0001-01-01T00:00:00Z` 这个零值，不是"没给"；
 * - `resolved` 不新建周期，但必须进导入主链路，把已有 ACTIVE 周期关掉；
 *   一次告警周期的外部键是 `fingerprint + startsAt`，恢复后再次 firing 会换 startsAt，不能被旧键吃掉；
 * - firing 的 `endsAt` 经常是预计恢复时间，不能写成 lastSeen；lastSeen 用接收时间；
 * - `instance` 永远带端口，设备匹配前必须剥掉端口。
 *
 * 不进 `severity` 推断的坑：Alertmanager 的 severity 是**人写的标签**，
 * 各团队口径完全不同（有的把 warning 当 P1 用）。因此这里只做字面映射，
 * 认不出来按 P2 —— 宁可把定级交给值班人在事件上改，也不要替他把全站打成 P0。
 */

const AlertSchema = z
  .object({
    status: z.string().optional(),
    labels: z.record(z.string()),
    annotations: z.record(z.string()).optional(),
    startsAt: z.string().optional(),
    endsAt: z.string().optional(),
    generatorURL: z.string().optional(),
    fingerprint: z.string().optional(),
  })
  .passthrough();

export const AlertmanagerPayloadSchema = z
  .object({
    version: z.string().optional(),
    status: z.string().optional(),
    alerts: z.array(AlertSchema).min(1).max(5000),
    commonLabels: z.record(z.string()).optional(),
    externalURL: z.string().optional(),
  })
  .passthrough();

type AmAlert = z.infer<typeof AlertSchema>;

export type AmParseResult = ParseResult & {
  /** 缺关键字段、整包无法解析时的丢弃计数。resolved 不再走这里。 */
  skipped: number;
};

/** 把 RFC3339（可能带纳秒）转成 Date；零值/非法值返回 null */
export function parseAmTime(value: string | undefined): Date | null {
  if (!value) return null;
  const text = value.trim();
  if (text.length === 0) return null;
  if (text.startsWith('0001-01-01')) return null;
  // V8 对 9 位小数秒的行为在不同版本上不一致，统一裁到毫秒
  const normalized = text.replace(/\.(\d{3})\d+/, '.$1');
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

const SEVERITY_BY_LABEL: Record<string, 'P0' | 'P1' | 'P2' | 'P3'> = {
  p0: 'P0',
  p1: 'P1',
  p2: 'P2',
  p3: 'P3',
  emergency: 'P0',
  fatal: 'P0',
  critical: 'P1',
  page: 'P1',
  high: 'P1',
  warning: 'P2',
  major: 'P2',
  info: 'P3',
  informational: 'P3',
  low: 'P3',
};

export function severityOfAlertmanager(raw: string | undefined): 'P0' | 'P1' | 'P2' | 'P3' {
  if (!raw) return 'P2';
  return SEVERITY_BY_LABEL[raw.trim().toLowerCase()] ?? 'P2';
}

type ConvertResult = { issue: string } | { alert: RawAlert };

function cycleState(
  alertStatus: string | undefined,
  payloadStatus: string | undefined,
): 'FIRING' | 'RESOLVED' {
  const raw = (alertStatus ?? payloadStatus ?? 'firing').trim().toLowerCase();
  return raw === 'resolved' ? 'RESOLVED' : 'FIRING';
}

function toRawAlert(
  alert: AmAlert,
  fallbackTime: Date,
  payloadStatus: string | undefined,
): ConvertResult {
  const labels = alert.labels ?? {};
  const annotations = alert.annotations ?? {};
  const alertname = labels.alertname ?? annotations.summary ?? 'Alertmanager 告警';
  const deviceName = pickInstanceLabel(labels);
  if (!deviceName) return { issue: '缺少 instance/host/node 标签，无法定位设备' as const };

  const startsAt = parseAmTime(alert.startsAt) ?? fallbackTime;
  const endsAt = parseAmTime(alert.endsAt);
  const state = cycleState(alert.status, payloadStatus);
  const fingerprint = alert.fingerprint ?? labels.fingerprint;
  // `|` 分开 fingerprint 和 startsAt：ISO 时间本身含冒号，前缀匹配不能用冒号切
  const externalKey = fingerprint ? `am:${fingerprint}|${startsAt.toISOString()}` : undefined;

  const value =
    numberFromAnnotations(annotations, ['value', 'current', 'observed']) ??
    (labels.value !== undefined ? Number(labels.value) : undefined);
  const threshold = numberFromAnnotations(annotations, ['threshold', 'limit']);

  return {
    alert: {
      externalKey,
      state,
      refreshOnDuplicate: state === 'FIRING',
      deviceName,
      type: classifyAlertName(alertname),
      severity: severityOfAlertmanager(labels.severity),
      metric: labels.metric ?? labels.__name__ ?? undefined,
      value: Number.isFinite(value) ? (value as number) : undefined,
      threshold: Number.isFinite(threshold) ? (threshold as number) : undefined,
      message: (annotations.summary ?? annotations.description ?? alertname).slice(0, 500),
      firstSeen: startsAt,
      // firing 的 endsAt 可能是预计恢复时间，写进 lastSeen 会把周期和聚合窗口推到未来
      lastSeen: state === 'RESOLVED' ? (endsAt ?? fallbackTime) : fallbackTime,
      count: 1,
      raw: {
        adapter: 'alertmanager',
        status: alert.status ?? payloadStatus ?? null,
        labels,
        annotations,
        generatorURL: alert.generatorURL ?? null,
        endsAt: alert.endsAt ?? null,
      },
    },
  };
}

/**
 * Alertmanager payload → RawAlert[]。
 * 部分告警缺关键字段时**不整体失败**：能导入的先导入，问题进 issues（与 CSV 导入一致）。
 */
export function parseAlertmanager(payload: unknown, now: Date = new Date()): AmParseResult {
  const parsed = AlertmanagerPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return {
      rows: [],
      skipped: 0,
      issues: parsed.error.issues.slice(0, 20).map((issue) => ({
        message: `${issue.path.join('.') || 'body'}: ${issue.message}`,
      })),
    };
  }

  const rows: AmParseResult['rows'] = [];
  const issues: ParseIssue[] = [];
  const skipped = 0;

  parsed.data.alerts.forEach((alert, index) => {
    const result = toRawAlert(alert, now, parsed.data.status);
    if ('issue' in result) {
      issues.push({ index, message: result.issue });
      return;
    }
    rows.push(result.alert);
  });

  return { rows, issues, skipped };
}

/** 设备映射页展示用：把 instance 归一化成别名候选 */
export function aliasCandidates(instance: string): string[] {
  const stripped = stripPort(instance);
  return [...new Set([instance.trim(), stripped].filter((v) => v.length > 0))];
}
