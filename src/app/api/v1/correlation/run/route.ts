import { NextResponse } from 'next/server';
import { z } from 'zod';
import { AppError, toErrorBody } from '@/lib/errors';
import { createLogger } from '@/lib/logger';
import { runCorrelation } from '@/modules/correlation/service';

export const dynamic = 'force-dynamic';

const log = createLogger('api.correlation.run');

const BodySchema = z
  .object({
    /** 仅调试用：用指定时刻作为聚合基准，便于复现历史窗口 */
    now: z.coerce.date().optional(),
  })
  .default({});

/**
 * POST /api/v1/correlation/run
 * 手动触发聚合。幂等：重复调用不会产生重复事件（AC-04 / AC-17）。
 */
export async function POST(req: Request) {
  const traceId = crypto.randomUUID();
  try {
    const raw = await req.text();
    const parsed = BodySchema.safeParse(raw.trim() ? JSON.parse(raw) : {});
    if (!parsed.success) {
      throw new AppError(
        'VALIDATION_FAILED',
        '请求体不合法：期望空 body 或 { now?: ISO8601 }',
        parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`),
      );
    }

    const summary = await runCorrelation(parsed.data.now);
    log.info('correlation_done', {
      traceId,
      created: summary.created.length,
      updated: summary.updated.length,
      reopened: summary.reopened.length,
      merged: summary.merged.length,
      durationMs: summary.durationMs,
    });

    return NextResponse.json({ ...summary, traceId }, { headers: { 'x-trace-id': traceId } });
  } catch (error) {
    const { status, body } = toErrorBody(error);
    log.error('correlation_failed', { traceId, err: String(error) });
    return NextResponse.json(body, { status, headers: { 'x-trace-id': traceId } });
  }
}
