import { NextResponse } from 'next/server';
import { createLogger } from '@/lib/logger';
import { toErrorBody } from '@/lib/errors';
import { getSystemStatus } from '@/modules/system/service';

export const dynamic = 'force-dynamic';

const log = createLogger('api.health');

export async function GET() {
  const traceId = crypto.randomUUID();
  try {
    const status = await getSystemStatus();
    return NextResponse.json(
      { ...status, traceId },
      { headers: { 'x-trace-id': traceId }, status: status.status === 'ok' ? 200 : 503 },
    );
  } catch (error) {
    log.error('health_check_failed', { traceId, err: String(error) });
    const { status, body } = toErrorBody(error);
    return NextResponse.json(body, { status, headers: { 'x-trace-id': traceId } });
  }
}
