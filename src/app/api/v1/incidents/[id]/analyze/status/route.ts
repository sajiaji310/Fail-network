import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { tenantOf } from '@/lib/auth';
import { toErrorBody } from '@/lib/errors';
import { getAnalysisProgress } from '@/modules/rca/progress';

export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/incidents/[id]/analyze/status — 研判阶段进度（评审第 3 阶段）。
 *
 * 研判本身仍是同步 POST：这里读的是那次请求在进程内留下的阶段记录，
 * 供前端在 POST 未返回时轮询。升级 SSE 时只需把本路由换成事件流，形状不变。
 *
 * 进程内表的限制写在 progress.ts：多实例部署下轮询可能打到另一个进程，
 * 届时返回 running=false，前端退化成"等着"——不会卡死，只是看不到阶段。
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const traceId = crypto.randomUUID();
  try {
    const { id } = await ctx.params;
    const owned = await db.incident.findFirst({
      where: { tenantId: tenantOf(_req), OR: [{ id }, { code: id }] },
      select: { id: true },
    });
    const progress = owned ? getAnalysisProgress(owned.id) : null;

    return NextResponse.json(
      {
        running: progress?.status === 'RUNNING',
        progress,
      },
      { headers: { 'x-trace-id': traceId, 'cache-control': 'no-store' } },
    );
  } catch (error) {
    const { status, body } = toErrorBody(error);
    return NextResponse.json(body, { status, headers: { 'x-trace-id': traceId } });
  }
}
