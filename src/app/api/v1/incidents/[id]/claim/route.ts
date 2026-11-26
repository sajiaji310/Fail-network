import { NextResponse } from 'next/server';
import { z } from 'zod';
import { tenantOf } from '@/lib/auth';
import { AppError, toErrorBody } from '@/lib/errors';
import { readJsonLimited } from '@/lib/http/body';
import { audited } from '@/modules/audit/service';
import { claimIncident, releaseIncident } from '@/modules/incidents/claim';

export const dynamic = 'force-dynamic';

const ClaimSchema = z.object({
  assignee: z.string().trim().min(1).max(40),
  team: z.string().trim().max(40).optional(),
  note: z.string().max(500).optional(),
  /** 转派：允许覆盖他人已接手的事件 */
  force: z.boolean().optional(),
});

/**
 * POST /api/v1/incidents/[id]/claim — 接手事件（评审 5.3）。
 *
 * 已被他人接手时返回 409 ALREADY_CLAIMED 并在 details 里带上当前责任人：
 * 前端据此弹"确认转派"，而不是让两个人同时以为自己负责。
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const traceId = crypto.randomUUID();
  try {
    const { id } = await ctx.params;
    const parsed = ClaimSchema.safeParse(await readJsonLimited(req));
    if (!parsed.success) {
      throw new AppError(
        'VALIDATION_FAILED',
        '请求体不合法：期望 { assignee, team?, note? }',
        parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`),
      );
    }

    const result = await audited(
      req,
      {
        action: 'incident.claim',
        target: id,
        detail: {
          assignee: parsed.data.assignee,
          team: parsed.data.team ?? null,
          force: parsed.data.force === true,
        },
        detailOf: (r) => ({ code: r.code, previousAssignee: r.previousAssignee }),
        requestId: traceId,
      },
      async () => {
        const claimed = await claimIncident({
          idOrCode: id,
          ...parsed.data,
          tenantId: tenantOf(req),
        });
        if (!claimed) throw new AppError('NOT_FOUND', `事件不存在：${id}`);
        return claimed;
      },
    );

    return NextResponse.json(result, { headers: { 'x-trace-id': traceId } });
  } catch (error) {
    const { status, body } = toErrorBody(error);
    return NextResponse.json(body, { status, headers: { 'x-trace-id': traceId } });
  }
}

/** DELETE /api/v1/incidents/[id]/claim — 释放事件（交回队列） */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const traceId = crypto.randomUUID();
  try {
    const { id } = await ctx.params;

    const result = await audited(
      req,
      {
        action: 'incident.release',
        target: id,
        detailOf: (r) => ({ code: r.code, releasedAssignee: r.releasedAssignee }),
        requestId: traceId,
      },
      async () => {
        const released = await releaseIncident({ idOrCode: id, tenantId: tenantOf(req) });
        if (!released) throw new AppError('NOT_FOUND', `事件不存在：${id}`);
        return released;
      },
    );

    return NextResponse.json(result, { headers: { 'x-trace-id': traceId } });
  } catch (error) {
    const { status, body } = toErrorBody(error);
    return NextResponse.json(body, { status, headers: { 'x-trace-id': traceId } });
  }
}
