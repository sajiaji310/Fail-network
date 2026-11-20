import { NextResponse } from 'next/server';
import { createLogger } from '@/lib/logger';
import { getSystemStatus, toPublicHealth } from '@/modules/system/service';

export const dynamic = 'force-dynamic';

const log = createLogger('api.ready');

/** 就绪探针：检查数据库连通性，db=down 时返回 503。用于 K8s readiness。 */
export async function GET() {
  const traceId = crypto.randomUUID();
  try {
    const status = await getSystemStatus();
    if (status.dbError) {
      log.warn('db_probe_failed', { traceId, err: status.dbError });
    }
    return NextResponse.json(
      { ...toPublicHealth(status), traceId },
      { headers: { 'x-trace-id': traceId }, status: status.db === 'up' ? 200 : 503 },
    );
  } catch (error) {
    log.error('ready_check_failed', { traceId, err: String(error) });
    return NextResponse.json(
      { status: 'degraded', db: 'down', llm: 'fallback', traceId },
      { status: 503, headers: { 'x-trace-id': traceId } },
    );
  }
}
