import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { db } from '@/lib/db';
import { runCorrelation, type CorrelationSummary } from '@/modules/correlation/service';
import { SeveritySchema, type RawAlert } from './schema';
import { ingestAlerts, type IngestResult } from './service';

export const SCENARIO_DIR = path.join(process.cwd(), 'scripts', 'fixtures', 'scenarios');

const ScenarioAlertSchema = z.object({
  deviceName: z.string().min(1),
  type: z.string().min(1),
  severity: SeveritySchema,
  metric: z.string().optional(),
  value: z.number().finite().optional(),
  threshold: z.number().finite().optional(),
  message: z.string().min(1),
  /** 相对剧本起点的分钟偏移，用来铺出"故障链"的时间顺序 */
  minuteFromStart: z.number().min(0).max(240),
  count: z.number().int().min(1).optional(),
});

const ScenarioChangeSchema = z.object({
  deviceName: z.string().min(1),
  kind: z.enum(['CONFIG', 'FIRMWARE', 'HARDWARE', 'CABLING']),
  content: z.string().min(1),
  operator: z.string().optional(),
  minuteFromStart: z.number().min(0).max(240),
});

export const ScenarioSchema = z.object({
  name: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  rootCauseHint: z.string().min(1),
  changes: z.array(ScenarioChangeSchema).default([]),
  alerts: z.array(ScenarioAlertSchema).min(1),
});

export type ScenarioSpec = z.infer<typeof ScenarioSchema>;
export type ScenarioAlert = z.infer<typeof ScenarioAlertSchema>;

export type MaterializedChange = {
  deviceName: string;
  kind: 'CONFIG' | 'FIRMWARE' | 'HARDWARE' | 'CABLING';
  content: string;
  operator?: string;
  changedAt: Date;
};

export type MaterializedScenario = {
  spec: ScenarioSpec;
  runId: string;
  alerts: RawAlert[];
  changes: MaterializedChange[];
};

/** 确定性伪随机：同一 seed 得到同一批数值抖动，便于回归对比 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function listScenarios(): string[] {
  return readdirSync(SCENARIO_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''))
    .sort();
}

export function loadScenario(name: string): ScenarioSpec {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`剧本名不合法：${name}`);
  const file = path.join(SCENARIO_DIR, `${name}.json`);
  const json: unknown = JSON.parse(readFileSync(file, 'utf8'));
  const parsed = ScenarioSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      `剧本 ${name} 结构不合法：${parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
    );
  }
  return parsed.data;
}

/**
 * 把剧本的"分钟偏移"铺到真实时间轴上：最后一个告警落在当前时间附近。
 * 每条告警带唯一 externalKey，重复导入同一批次返回 deduped。
 */
export function materialize(
  spec: ScenarioSpec,
  opts: { seed?: number; now?: Date; runId?: string } = {},
): MaterializedScenario {
  const now = opts.now ?? new Date();
  const runId = opts.runId ?? now.getTime().toString(36);
  const rand = mulberry32(opts.seed ?? 42);
  const span = Math.max(...spec.alerts.map((a) => a.minuteFromStart));
  const startMs = now.getTime() - (span + 2) * 60_000;

  const alerts = spec.alerts.map((a, index): RawAlert => {
    const at = new Date(startMs + a.minuteFromStart * 60_000 + Math.floor(rand() * 20_000));
    const jitter = 1 + (rand() - 0.5) * 0.02;
    return {
      externalKey: `SIM-${spec.name}-${runId}-${index}`,
      deviceName: a.deviceName,
      type: a.type,
      severity: a.severity,
      metric: a.metric,
      value: a.value === undefined ? undefined : Number((a.value * jitter).toFixed(2)),
      threshold: a.threshold,
      message: a.message,
      firstSeen: at,
      lastSeen: at,
      count: a.count,
      raw: { scenario: spec.name, rootCauseHint: spec.rootCauseHint },
    };
  });

  const changes = spec.changes.map((c) => ({
    deviceName: c.deviceName,
    kind: c.kind,
    content: c.content,
    operator: c.operator,
    changedAt: new Date(startMs + c.minuteFromStart * 60_000),
  }));

  return { spec, runId, alerts, changes };
}

async function writeChanges(changes: MaterializedChange[]): Promise<number> {
  if (changes.length === 0) return 0;
  const names = [...new Set(changes.map((c) => c.deviceName))];
  const devices = await db.device.findMany({
    where: { name: { in: names } },
    select: { id: true, name: true },
  });
  const idByName = new Map(devices.map((d) => [d.name, d.id]));
  let written = 0;

  for (const change of changes) {
    const deviceId = idByName.get(change.deviceName);
    if (!deviceId) continue;
    await db.changeRecord.create({
      data: {
        deviceId,
        kind: change.kind,
        content: change.content,
        operator: change.operator,
        changedAt: change.changedAt,
      },
    });
    written++;
  }
  return written;
}

export type SimulateResult = {
  scenario: string;
  title: string;
  runId: string;
  alertTotal: number;
  changes: number;
  ingest: IngestResult;
  /** 本次注入触达的事件（新建/沿用/重开） */
  incidentIds: string[];
  correlation: CorrelationSummary;
};

/** 剧本注入：落告警 + 变更记录，然后立即聚合出事件（T05） */
export async function runScenario(name: string, seed?: number): Promise<SimulateResult> {
  const spec = loadScenario(name);
  const materialized = materialize(spec, { seed });
  const ingest = await ingestAlerts(`sim:${name}`, materialized.alerts);
  const changes = await writeChanges(materialized.changes);

  const correlation = await runCorrelation();
  const incidentIds = [
    ...new Set([
      ...correlation.created.map((i) => i.id),
      ...correlation.updated.map((i) => i.id),
      ...correlation.reopened.map((i) => i.id),
    ]),
  ];

  return {
    scenario: spec.name,
    title: spec.title,
    runId: materialized.runId,
    alertTotal: materialized.alerts.length,
    changes,
    ingest,
    incidentIds,
    correlation,
  };
}
