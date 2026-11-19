import { NextResponse } from 'next/server';
import { z } from 'zod';
import { AppError, toErrorBody } from '@/lib/errors';
import { setHypothesisVerdict } from '@/modules/incidents/lifecycle';

export const dynamic = 'force-dynamic';

const BodySchema = z.object({
  /** null = 撤销裁决 */
  verdict: z.enum(['ACCEPTED', 'REJECTED']).nullable(),
  note: z.string().max(500).optional(),
});

/**
 * PATCH /api/v1/incidents/[id]/hypotheses/[hypothesisId] — 采纳/否决一条根因假设（F7）。
 *
 * 采纳是单选：同一事件里只允许一条 ACCEPTED，服务端负责把其它降级，
 * 前端不要自己算"选了这条就把别的不选"。
 */
export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string; hypothesisId: string }> },
) {
  const traceId = crypto.randomUUID();
  try {
    const { id, hypothesisId } = await ctx.params;
    const raw = await req.json().catch(() => null);
    const parsed = BodySchema.safeParse(raw);
    if (!parsed.success) {
      throw new AppError(
        'VALIDATION_FAILED',
        '请求体不合法',
        parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`),
      );
    }

    const result = await setHypothesisVerdict({
      incidentIdOrCode: id,
      hypothesisId,
      verdict: parsed.data.verdict,
      note: parsed.data.note ?? null,
    });
    if (!result) {
      throw new AppError('NOT_FOUND', `事件或假设不存在：${id} / ${hypothesisId}`);
    }

    return NextResponse.json(result, { headers: { 'x-trace-id': traceId } });
  } catch (error) {
    const { status, body } = toErrorBody(error);
    return NextResponse.json(body, { status, headers: { 'x-trace-id': traceId } });
  }
}
