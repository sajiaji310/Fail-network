import { NextResponse } from 'next/server';
import { z } from 'zod';
import { AppError, toErrorBody } from '@/lib/errors';
import { listCases } from '@/modules/case/service';

export const dynamic = 'force-dynamic';

const QuerySchema = z.object({
  q: z.string().max(120).optional(),
  tag: z.string().max(40).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

/** GET /api/v1/cases?q=光模块&tag=硬件&page=1（文档 9 节第 17 条） */
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
    const result = await listCases(parsed.data);
    return NextResponse.json(result, { headers: { 'x-trace-id': traceId } });
  } catch (error) {
    const { status, body } = toErrorBody(error);
    return NextResponse.json(body, { status, headers: { 'x-trace-id': traceId } });
  }
}
