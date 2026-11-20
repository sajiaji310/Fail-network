import { NextResponse } from 'next/server';
import { z } from 'zod';
import { tenantOf } from '@/lib/auth';
import { AppError, toErrorBody } from '@/lib/errors';
import { readJsonLimited } from '@/lib/http/body';
import { audited } from '@/modules/audit/service';
import { getIncidentDetail } from '@/modules/incidents/detail';
import { transitionIncident } from '@/modules/incidents/lifecycle';

export const dynamic = 'force-dynamic';

/** GET /api/v1/incidents/[id] — id 或事件编码（INC-YYYYMMDD-NNN）都接受 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const traceId = crypto.randomUUID();
  try {
    const { id } = await ctx.params;
    const detail = await getIncidentDetail(id, tenantOf(_req));
    if (!detail) {
      throw new AppError('NOT_FOUND', `事件不存在：${id}`);
    }
    return NextResponse.json(detail, { headers: { 'x-trace-id': traceId } });
  } catch (error) {
    const { status, body } = toErrorBody(error);
    return NextResponse.json(body, { status, headers: { 'x-trace-id': traceId } });
  }
}

const PatchSchema = z.object({
  status: z.enum(['OPEN', 'ANALYZING', 'LOCATED', 'MITIGATED', 'RESOLVED', 'CLOSED']),
  note: z.string().max(500).optional(),
});

/**
 * PATCH /api/v1/incidents/[id] — 状态流转（文档 9 节第 14 条）。
 *
 * 非法流转（含 AC-08 的 RESOLVED → OPEN）返回 409 INVALID_TRANSITION，
 * 而不是悄悄忽略：前端要靠这个状态码把按钮置灰并提示"事件已结案"。
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const traceId = crypto.randomUUID();
  try {
    const { id } = await ctx.params;
    const raw = await readJsonLimited(req);
    const parsed = PatchSchema.safeParse(raw);
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
        action: 'incident.transition',
        target: id,
        detail: { to: parsed.data.status, note: parsed.data.note ?? null },
        detailOf: (r) => ({ code: r.code, from: r.from, changed: r.changed }),
        requestId: traceId,
      },
      async () => {
        const transitioned = await transitionIncident({
          idOrCode: id,
          to: parsed.data.status,
          note: parsed.data.note ?? null,
        });
        if (!transitioned) {
          throw new AppError('NOT_FOUND', `事件不存在：${id}`);
        }
        return transitioned;
      },
    );

    return NextResponse.json(result, { headers: { 'x-trace-id': traceId } });
  } catch (error) {
    const { status, body } = toErrorBody(error);
    return NextResponse.json(body, { status, headers: { 'x-trace-id': traceId } });
  }
}
