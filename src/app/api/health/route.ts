import { NextResponse } from 'next/server';
import { createLogger } from '@/lib/logger';
import { toErrorBody } from '@/lib/errors';
import { getSystemStatus, toPublicHealth } from '@/modules/system/service';

export const dynamic = 'force-dynamic';

const log = createLogger('api.health');

/**
 * 对外健康检查（P0-2 脱敏）：只返回 status / db / llm / traceId。
 * 数据库错误明细只写结构化日志，不回传客户端 —— 避免泄露连接串/主机名/驱动错误。
 * 存活探针用 /api/live（不查库），就绪探针用 /api/ready（查库）。
 */
export async function GET() {
  const traceId = crypto.randomUUID();
  try {
    const status = await getSystemStatus();
    if (status.dbError) {
      log.warn('db_probe_failed', { traceId, err: status.dbError });
    }
    return NextResponse.json(
      { ...toPublicHealth(status), traceId },
      { headers: { 'x-trace-id': traceId }, status: status.status === 'ok' ? 200 : 503 },
    );
  } catch (error) {
    log.error('health_check_failed', { traceId, err: String(error) });
    const { status, body } = toErrorBody(error);
    return NextResponse.json(body, { status, headers: { 'x-trace-id': traceId } });
  }
}
