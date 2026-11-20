import { z } from 'zod';
import type { ParseIssue, ParseResult, RawAlert } from '../schema';
import { classifyAlertName, stripPort } from './classify';

/**
 * Zabbix 适配器。
 *
 * 兼容三种常见来源，因为 Zabbix 没有标准的告警 webhook 格式，
 * 各家的 media type 脚本吐出来的字段名都不一样：
 *   1. media type 的单条事件：`{ host, trigger, severity, eventid, clock }`
 *   2. 自定义脚本汇总：`{ problems: [ ... ] }`
 *   3. 数组：`[ ... ]`
 *
 * 字段名做同义词收敛（host/hostName/host_name、trigger/name/title），
 * 宁可多认几种写法，也不要求用户改他们的 Zabbix 脚本 —— 改脚本是接入成本最高的一步。
 */

const ItemSchema = z.record(z.unknown());

/** Zabbix 严重度 0–5：0 未分类 / 1 信息 / 2 警告 / 3 一般严重 / 4 严重 / 5 灾难 */
const SEVERITY_BY_LEVEL: ReadonlyArray<'P0' | 'P1' | 'P2' | 'P3'> = [
  'P3',
  'P3',
  'P2',
  'P2',
  'P1',
  'P0',
];

const SEVERITY_BY_TEXT: Record<string, 'P0' | 'P1' | 'P2' | 'P3'> = {
  'not classified': 'P3',
  information: 'P3',
  info: 'P3',
  warning: 'P2',
  average: 'P2',
  high: 'P1',
  disaster: 'P0',
  p0: 'P0',
  p1: 'P1',
  p2: 'P2',
  p3: 'P3',
};

export type ZabbixParseResult = ParseResult & { skipped: number };

function pickString(item: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = item[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

function pickNumber(item: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = item[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim().length > 0) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

export function severityOfZabbix(item: Record<string, unknown>): 'P0' | 'P1' | 'P2' | 'P3' {
  const numeric = pickNumber(item, ['severity', 'priority', 'trigger_severity']);
  if (numeric !== undefined) {
    const level = Math.max(0, Math.min(5, Math.trunc(numeric)));
    return SEVERITY_BY_LEVEL[level] ?? 'P2';
  }
  const text = pickString(item, ['severity', 'priority', 'severityName']);
  if (text) {
    const mapped = SEVERITY_BY_TEXT[text.toLowerCase()];
    if (mapped) return mapped;
  }
  return 'P2';
}

/** `clock` 是 Unix 秒；也接受 `eventDate` + `eventTime`（`2026.11.20` + `15:04:05`） */
export function zabbixTime(item: Record<string, unknown>, fallback: Date): Date {
  const clock = pickNumber(item, ['clock', 'eventTimeUnix', 'timestamp']);
  if (clock !== undefined && clock > 0) {
    // 兼容毫秒时间戳：Zabbix 本身是秒，但自建脚本常直接塞 Date.now()
    const ms = clock > 1e12 ? clock : clock * 1000;
    const date = new Date(ms);
    if (!Number.isNaN(date.getTime())) return date;
  }

  const dateText = pickString(item, ['eventDate', 'date']);
  const timeText = pickString(item, ['eventTime', 'time']);
  if (dateText) {
    const isoDate = dateText.replace(/\./g, '-');
    const candidate = new Date(timeText ? `${isoDate}T${timeText}` : isoDate);
    if (!Number.isNaN(candidate.getTime())) return candidate;
  }

  const startsAt = pickString(item, ['startsAt', 'startedAt']);
  if (startsAt) {
    const candidate = new Date(startsAt);
    if (!Number.isNaN(candidate.getTime())) return candidate;
  }
  return fallback;
}

function isResolved(item: Record<string, unknown>): boolean {
  const status = pickString(item, ['status', 'eventStatus', 'state']);
  if (status) {
    const text = status.toLowerCase();
    if (text === 'resolved' || text === 'ok' || text === 'recovery') return true;
    if (text === 'problem' || text === 'firing' || text === 'alert') return false;
  }
  // Zabbix 事件值：1 = problem，0 = resolved
  const value = pickNumber(item, ['eventValue', 'value', 'event_value']);
  if (value !== undefined && (value === 0 || value === 1)) return value === 0;
  return false;
}

type ConvertResult = { issue: string } | { alert: RawAlert };

function toRawAlert(item: Record<string, unknown>, now: Date): ConvertResult {
  const deviceRaw = pickString(item, ['host', 'hostName', 'host_name', 'hostname', 'device']);
  if (!deviceRaw) return { issue: '缺少 host 字段，无法定位设备' as const };

  const name =
    pickString(item, ['trigger', 'name', 'title', 'problem', 'description']) ?? 'Zabbix 告警';
  const eventId = pickString(item, ['eventid', 'eventId', 'event_id']);
  const startsAt = zabbixTime(item, now);
  const count = pickNumber(item, ['eventCount', 'count']);

  return {
    alert: {
      externalKey: eventId ? `zbx:${eventId}` : undefined,
      deviceName: stripPort(deviceRaw),
      type: classifyAlertName(name),
      severity: severityOfZabbix(item),
      metric: pickString(item, ['itemKey', 'key', 'metric']) ?? undefined,
      value: pickNumber(item, ['lastValue', 'itemValue', 'current']),
      threshold: pickNumber(item, ['threshold', 'triggerValue']),
      message: name.slice(0, 500),
      firstSeen: startsAt,
      lastSeen: startsAt,
      count: count !== undefined ? Math.max(1, Math.trunc(count)) : 1,
      raw: { adapter: 'zabbix', item },
    },
  };
}

/** 取出条目数组：支持 `{problems:[]}` / `{alerts:[]}` / 裸数组 / 单个对象 */
export function zabbixItems(payload: unknown): unknown[] | null {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>;
    for (const key of ['problems', 'alerts', 'events', 'data']) {
      const value = obj[key];
      if (Array.isArray(value)) return value;
    }
    return [obj];
  }
  return null;
}

export function parseZabbix(payload: unknown, now: Date = new Date()): ZabbixParseResult {
  const items = zabbixItems(payload);
  if (!items) {
    return { rows: [], skipped: 0, issues: [{ message: '请求体既不是对象也不是数组' }] };
  }
  if (items.length === 0) {
    return { rows: [], skipped: 0, issues: [{ message: '没有可导入的 Zabbix 事件' }] };
  }
  if (items.length > 5000) {
    return { rows: [], skipped: 0, issues: [{ message: '单批事件数超过 5000，请分批推送' }] };
  }

  const rows: ZabbixParseResult['rows'] = [];
  const issues: ParseIssue[] = [];
  let skipped = 0;

  items.forEach((item, index) => {
    const parsedItem = ItemSchema.safeParse(item);
    if (!parsedItem.success) {
      issues.push({ index, message: '条目不是对象' });
      return;
    }
    const record = parsedItem.data;
    if (isResolved(record)) {
      skipped++;
      return;
    }
    const result = toRawAlert(record, now);
    if ('issue' in result) {
      issues.push({ index, message: result.issue });
      return;
    }
    rows.push(result.alert);
  });

  return { rows, issues, skipped };
}
