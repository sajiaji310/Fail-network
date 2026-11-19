import { z } from 'zod';

/** 严重度与 Prisma 枚举保持一致 */
export const SeveritySchema = z.enum(['P0', 'P1', 'P2', 'P3']);

/**
 * 原始告警行：贴近 Zabbix / Prometheus Alertmanager 的告警字段，
 * 但不绑定任何具体采集器 —— 接入层只认这一种结构。
 */
export const RawAlertSchema = z.object({
  /** 上游告警 ID；有则按它幂等（同一 ID 重复导入只算一条） */
  externalKey: z.string().min(1).max(200).optional(),
  deviceName: z.string().min(1).max(120),
  type: z.string().min(1).max(64),
  severity: SeveritySchema,
  metric: z.string().max(64).optional(),
  value: z.number().finite().optional(),
  threshold: z.number().finite().optional(),
  message: z.string().min(1).max(500),
  firstSeen: z.coerce.date(),
  lastSeen: z.coerce.date().optional(),
  /** 同一条告警在上游被聚合的次数 */
  count: z.number().int().min(1).max(100_000).optional(),
  raw: z.record(z.unknown()).optional(),
});

export type RawAlert = z.infer<typeof RawAlertSchema>;

/** JSON 导入体：{source, alerts:[...]} */
export const IngestJsonBodySchema = z.object({
  source: z.string().min(1).max(64),
  alerts: z.array(z.unknown()).max(5000),
});

export type IngestJsonBody = z.infer<typeof IngestJsonBodySchema>;

/** CSV 导入体：{source, format:'csv', data:'...'} */
export const IngestCsvBodySchema = z.object({
  source: z.string().min(1).max(64),
  format: z.literal('csv'),
  data: z.string().min(1),
});

export type IngestCsvBody = z.infer<typeof IngestCsvBodySchema>;

export type ParseIssue = { line?: number; index?: number; message: string };

export type ParseResult = { rows: RawAlert[]; issues: ParseIssue[] };
