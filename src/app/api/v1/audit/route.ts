import { NextResponse } from 'next/server';
import { z } from 'zod';
import { tenantOf } from '@/lib/auth';
import { AppError, toErrorBody } from '@/lib/errors';
import { listAudit } from '@/modules/audit/service';

export const dynamic = 'force-dynamic';

const QuerySchema = z.object({
  action: z.string().max(40).optional(),
  result: z.enum(['OK', 'FAIL']).optional(),
  actor: z.string().max(80).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  /** 上一页最后一条的 at（ISO 时间），用于向前翻页 */
  cursor: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(30),
});

/**
 * GET /api/v1/audit — 操作审计查询（第 1 阶段建立，第 4 阶段补检索条件）。
 *
 * 只读。production 下由中间件要求 ADMIN 角色（审计表能反推"谁动了什么"，
 * 不该和普通读接口一样敞开）。返回 `nextCursor` 支持按时间倒序翻页。
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

    const items = await listAudit({ ...parsed.data, tenantId: tenantOf(req) });
    const last = items[items.length - 1];
    return NextResponse.json(
      {
        items,
        total: items.length,
        nextCursor: items.length >= parsed.data.limit && last ? last.at : null,
      },
      { headers: { 'x-trace-id': traceId } },
    );
  } catch (error) {
    const { status, body } = toErrorBody(error);
    return NextResponse.json(body, { status, headers: { 'x-trace-id': traceId } });
  }
}
