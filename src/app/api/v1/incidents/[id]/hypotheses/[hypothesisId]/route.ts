import { NextResponse } from 'next/server';
import { z } from 'zod';
import { tenantOf } from '@/lib/auth';
import { AppError, toErrorBody } from '@/lib/errors';
import { readJsonLimited } from '@/lib/http/body';
import { audited } from '@/modules/audit/service';
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
    const raw = await readJsonLimited(req);
    const parsed = BodySchema.safeParse(raw);
    if (!parsed.success) {
      throw new AppError(
        'VALIDATION_FAILED',
        '请求体不合法',
        parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`),
      );
    }

    const result = await audited(
      req,
      {
        action: 'hypothesis.verdict',
        target: `${id}/${hypothesisId}`,
        detail: { verdict: parsed.data.verdict, note: parsed.data.note ?? null },
        detailOf: (r) => ({ acceptedHypothesisId: r.acceptedHypothesisId }),
        requestId: traceId,
      },
      async () => {
        const updated = await setHypothesisVerdict({
          incidentIdOrCode: id,
          hypothesisId,
          verdict: parsed.data.verdict,
          note: parsed.data.note ?? null,
          tenantId: tenantOf(req),
        });
        if (!updated) {
          throw new AppError('NOT_FOUND', `事件或假设不存在：${id} / ${hypothesisId}`);
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
