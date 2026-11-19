import { db } from '@/lib/db';
import { env, llmMode, type LlmMode } from '@/lib/env';

export type DbStatus = 'up' | 'down';

export type SystemStatus = {
  status: 'ok' | 'degraded';
  db: DbStatus;
  dbVersion?: string;
  llm: LlmMode;
  llmModel: string;
  node: string;
  stage: string;
  checkedAt: string;
  dbError?: string;
};

const STAGE = 'T07 根因研判';

async function probeDb(): Promise<{ status: DbStatus; version?: string; error?: string }> {
  try {
    const rows = await db.$queryRaw<{ version: string }[]>`SELECT version()`;
    const version = rows[0]?.version.split(' on ')[0] ?? undefined;
    return { status: 'up', version };
  } catch (error) {
    return { status: 'down', error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 环境自检：/api/health 与概览页共用同一份实现（分层：app + api → modules → lib）
 */
export async function getSystemStatus(): Promise<SystemStatus> {
  const dbResult = await probeDb();
  const mode = llmMode();
  return {
    status: dbResult.status === 'up' ? 'ok' : 'degraded',
    db: dbResult.status,
    dbVersion: dbResult.version,
    dbError: dbResult.error,
    llm: mode,
    llmModel: mode === 'live' ? env.LLM_MODEL_REASON : '—',
    node: process.version,
    stage: STAGE,
    checkedAt: new Date().toISOString(),
  };
}

/** 种子基线（T02）：设备 30 / 链路 60 / 案例 30 */
export const SEED_BASELINE = { devices: 30, links: 60, cases: 30 } as const;

export type DataSummary = {
  devices: number;
  links: number;
  cases: number;
  alerts: number;
  seedReady: boolean;
};

export async function getDataSummary(): Promise<DataSummary> {
  try {
    const [devices, links, cases, alerts] = await Promise.all([
      db.device.count(),
      db.topologyLink.count(),
      db.caseRecord.count(),
      db.alert.count(),
    ]);
    return {
      devices,
      links,
      cases,
      alerts,
      seedReady:
        devices >= SEED_BASELINE.devices &&
        links >= SEED_BASELINE.links &&
        cases >= SEED_BASELINE.cases,
    };
  } catch {
    // DB 不可用时由 getSystemStatus 的错误横幅负责提示，这里只降级为 0
    return { devices: 0, links: 0, cases: 0, alerts: 0, seedReady: false };
  }
}
