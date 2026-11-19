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

const STAGE = 'T01 工程基座';

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
