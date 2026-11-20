import { NextResponse } from 'next/server';
import { z } from 'zod';
import { AppError, toErrorBody } from '@/lib/errors';
import { readJsonLimited } from '@/lib/http/body';
import { audited } from '@/modules/audit/service';
import { splitIncident } from '@/modules/incidents/split';

export const dynamic = 'force-dynamic';

const BodySchema = z.object({
  alertIds: z.array(z.string().min(1)).min(1).max(200),
  note: z.string().max(500).optional(),
});

/**
 * POST /api/v1/incidents/[id]/split — 把选中告警拆成新事件。
 *
 * 自动聚合必然会有判错的时候，这是唯一的人工纠正入口。
 * 拆分后两边都会被聚合一侧的合并规则跳过（splitFromId），不会下一轮又并回去。
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const traceId = crypto.randomUUID();
  try {
    const { id } = await ctx.params;
    const parsed = BodySchema.safeParse(await readJsonLimited(req));
    if (!parsed.success) {
      throw new AppError(
        'VALIDATION_FAILED',
        '请求体不合法：期望 { alertIds: string[], note? }',
        parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`),
      );
    }

    const result = await audited(
      req,
      {
        action: 'incident.split',
        target: id,
        detail: { alertCount: parsed.data.alertIds.length, note: parsed.data.note ?? null },
        detailOf: (r) => ({ targetCode: r.target.code, moved: r.moved }),
        requestId: traceId,
      },
      async () => {
        const split = await splitIncident({
          idOrCode: id,
          alertIds: parsed.data.alertIds,
          note: parsed.data.note ?? null,
        });
        if (!split) {
          throw new AppError('NOT_FOUND', `事件不存在：${id}`);
        }
        return split;
      },
    );

    return NextResponse.json(result, { headers: { 'x-trace-id': traceId } });
  } catch (error) {
    const { status, body } = toErrorBody(error);
    return NextResponse.json(body, { status, headers: { 'x-trace-id': traceId } });
  }
}
