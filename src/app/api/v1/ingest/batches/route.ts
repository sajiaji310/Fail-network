import { NextResponse } from 'next/server';
import { z } from 'zod';
import { tenantOf } from '@/lib/auth';
import { AppError, toErrorBody } from '@/lib/errors';
import { listBatches, markStaleBatches } from '@/modules/ingest/batch';

export const dynamic = 'force-dynamic';

const QuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  /** 顺手清理进程重启留下的假 RUNNING 批次 */
  sweep: z.enum(['0', '1']).default('1'),
});

/** GET /api/v1/ingest/batches — 最近的导入批次（按租户隔离） */
export async function GET(req: Request) {
  const traceId = crypto.randomUUID();
  try {
    const params = Object.fromEntries(new URL(req.url).searchParams.entries());
    const parsed = QuerySchema.safeParse(params);
    if (!parsed.success) {
      throw new AppError(
        'VALIDATION_FAILED',
        '查询参数不合法',
        parsed.error.issues.map((i) => `${i.path.join('.') || 'query'}: ${i.message}`),
      );
    }

    if (parsed.data.sweep === '1') {
      await markStaleBatches().catch(() => 0);
    }

    const items = await listBatches(tenantOf(req), parsed.data.limit);
    return NextResponse.json(
      {
        items,
        total: items.length,
        running: items.filter((b) => b.status === 'QUEUED' || b.status === 'RUNNING').length,
      },
      { headers: { 'x-trace-id': traceId } },
    );
  } catch (error) {
    const { status, body } = toErrorBody(error);
    return NextResponse.json(body, { status, headers: { 'x-trace-id': traceId } });
  }
}
