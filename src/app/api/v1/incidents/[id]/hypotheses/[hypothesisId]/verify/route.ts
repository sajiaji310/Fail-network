import { NextResponse } from 'next/server';
import { z } from 'zod';
import { AppError, toErrorBody } from '@/lib/errors';
import { readJsonLimited } from '@/lib/http/body';
import { audited, resolveActor } from '@/modules/audit/service';
import { setVerifyStep } from '@/modules/incidents/verify-steps';

export const dynamic = 'force-dynamic';

const BodySchema = z.object({
  stepIndex: z.number().int().min(0).max(50),
  done: z.boolean(),
  note: z.string().max(300).optional(),
});

/**
 * POST /api/v1/incidents/[id]/hypotheses/[hypothesisId]/verify — 勾选/取消一条验证步骤。
 *
 * 用 POST + done 布尔而不是 DELETE：
 * 取消勾选也要记一行审计，POST 让"勾了、又取消了"在审计里是两条记录，
 * 而不是一条被抹掉的痕迹。
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string; hypothesisId: string }> },
) {
  const traceId = crypto.randomUUID();
  try {
    const { id, hypothesisId } = await ctx.params;
    const parsed = BodySchema.safeParse(await readJsonLimited(req));
    if (!parsed.success) {
      throw new AppError(
        'VALIDATION_FAILED',
        '请求体不合法：期望 { stepIndex, done, note?, by? }',
        parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`),
      );
    }

    const result = await audited(
      req,
      {
        action: 'hypothesis.verify',
        target: `${id}/${hypothesisId}#${parsed.data.stepIndex}`,
        detail: { done: parsed.data.done },
        detailOf: (r) => ({ done: r.done, total: r.total }),
        requestId: traceId,
      },
      async () => {
        const updated = await setVerifyStep({
          incidentIdOrCode: id,
          hypothesisId,
          stepIndex: parsed.data.stepIndex,
          done: parsed.data.done,
          note: parsed.data.note ?? null,
          // 操作者由服务端解析，不接受前端自称：验证记录是审计材料
          by: resolveActor(req),
        });
        if (!updated) throw new AppError('NOT_FOUND', `事件不存在：${id}`);
        return updated;
      },
    );

    return NextResponse.json(result, { headers: { 'x-trace-id': traceId } });
  } catch (error) {
    const { status, body } = toErrorBody(error);
    return NextResponse.json(body, { status, headers: { 'x-trace-id': traceId } });
  }
}
