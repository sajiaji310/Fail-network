import { NextResponse } from 'next/server';
import { z } from 'zod';
import { AppError, toErrorBody } from '@/lib/errors';
import { listAudit } from '@/modules/audit/service';

export const dynamic = 'force-dynamic';

const QuerySchema = z.object({
  action: z.string().max(40).optional(),
  result: z.enum(['OK', 'FAIL']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(30),
});

/**
 * GET /api/v1/audit — 操作审计查询（评审第 1 阶段）。
 *
 * 只读。production 下由中间件要求 API Key（审计表能反推"谁动了什么"，
 * 不该和普通读接口一样敞开）。
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
    const items = await listAudit(parsed.data);
    return NextResponse.json(
      { items, total: items.length },
      { headers: { 'x-trace-id': traceId } },
    );
  } catch (error) {
    const { status, body } = toErrorBody(error);
    return NextResponse.json(body, { status, headers: { 'x-trace-id': traceId } });
  }
}
