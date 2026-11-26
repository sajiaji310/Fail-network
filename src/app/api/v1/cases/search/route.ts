import { NextResponse } from 'next/server';
import { z } from 'zod';
import { tenantOf } from '@/lib/auth';
import { AppError, toErrorBody } from '@/lib/errors';
import { searchCases } from '@/modules/case/service';

export const dynamic = 'force-dynamic';

const QuerySchema = z.object({
  q: z.string().max(120).optional(),
  /** 传事件 id 或编码时，用该事件的告警类型/设备层级召回相似案例，并排除自身 */
  incidentId: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(20).default(3),
});

/**
 * GET /api/v1/cases/search?q=光模块&limit=3（文档 9 节第 18 条）
 * GET /api/v1/cases/search?incidentId=INC-20261119-001
 */
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

    const items = await searchCases({ ...parsed.data, tenantId: tenantOf(req) });
    return NextResponse.json(
      { items, total: items.length },
      { headers: { 'x-trace-id': traceId } },
    );
  } catch (error) {
    const { status, body } = toErrorBody(error);
    return NextResponse.json(body, { status, headers: { 'x-trace-id': traceId } });
  }
}
