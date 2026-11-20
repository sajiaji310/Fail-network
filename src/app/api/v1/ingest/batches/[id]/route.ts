import { NextResponse } from 'next/server';
import { tenantOf } from '@/lib/auth';
import { AppError, toErrorBody } from '@/lib/errors';
import { getBatch } from '@/modules/ingest/batch';

export const dynamic = 'force-dynamic';

/** GET /api/v1/ingest/batches/[id] — 批次状态与累计计数 */
export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  const traceId = crypto.randomUUID();
  try {
    const { id } = await context.params;
    const batch = await getBatch(id, tenantOf(req));
    if (!batch) throw new AppError('NOT_FOUND', `批次不存在：${id}`);
    return NextResponse.json(batch, {
      // 进度是实时数据，中间层不能缓存
      headers: { 'x-trace-id': traceId, 'cache-control': 'no-store' },
    });
  } catch (error) {
    const { status, body } = toErrorBody(error);
    return NextResponse.json(body, { status, headers: { 'x-trace-id': traceId } });
  }
}
