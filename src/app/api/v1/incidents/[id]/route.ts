import { NextResponse } from 'next/server';
import { AppError, toErrorBody } from '@/lib/errors';
import { getIncidentDetail } from '@/modules/incidents/detail';

export const dynamic = 'force-dynamic';

/** GET /api/v1/incidents/[id] — id 或事件编码（INC-YYYYMMDD-NNN）都接受 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const traceId = crypto.randomUUID();
  try {
    const { id } = await ctx.params;
    const detail = await getIncidentDetail(id);
    if (!detail) {
      throw new AppError('NOT_FOUND', `事件不存在：${id}`);
    }
    return NextResponse.json(detail, { headers: { 'x-trace-id': traceId } });
  } catch (error) {
    const { status, body } = toErrorBody(error);
    return NextResponse.json(body, { status, headers: { 'x-trace-id': traceId } });
  }
}
