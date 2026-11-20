import { NextResponse } from 'next/server';
import { z } from 'zod';
import { AppError, toErrorBody } from '@/lib/errors';
import { readJsonLimited } from '@/lib/http/body';
import { audited, resolveActor } from '@/modules/audit/service';
import { setCaseVerification } from '@/modules/case/service';

export const dynamic = 'force-dynamic';

const BodySchema = z.object({
  /** UNVERIFIED = 撤销人工结论，回到待确认 */
  verification: z.enum(['VERIFIED', 'REJECTED', 'UNVERIFIED']),
  note: z.string().max(500).optional(),
});

/**
 * PATCH /api/v1/cases/[id] — 人工确认 / 驳回一条案例（评审 P0-3）。
 *
 * 未验证的案例不参与 RCA 召回，这个接口就是它唯一的晋升通道：
 * 有人在案例库里看过、认可这条经验，它才有资格进入下一次研判的上下文。
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const traceId = crypto.randomUUID();
  try {
    const { id } = await ctx.params;
    const parsed = BodySchema.safeParse(await readJsonLimited(req));
    if (!parsed.success) {
      throw new AppError(
        'VALIDATION_FAILED',
        '请求体不合法：期望 { verification, note? }',
        parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`),
      );
    }

    const result = await audited(
      req,
      {
        action: 'case.verify',
        target: id,
        detail: { verification: parsed.data.verification, note: parsed.data.note ?? null },
        detailOf: (r) => ({ incidentCode: r.incidentCode }),
        requestId: traceId,
      },
      async () => {
        const updated = await setCaseVerification({
          id,
          verification: parsed.data.verification,
          by: resolveActor(req),
          note: parsed.data.note ?? null,
        });
        if (!updated) {
          throw new AppError('NOT_FOUND', `案例不存在：${id}`);
        }
        return updated;
      },
    );

    return NextResponse.json(result, { headers: { 'x-trace-id': traceId } });
  } catch (error) {
    const { status, body } = toErrorBody(error);
    return NextResponse.json(body, { status, headers: { 'x-trace-id': traceId } });
  }
}
