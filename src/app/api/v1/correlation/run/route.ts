import { NextResponse } from 'next/server';
import { z } from 'zod';
import { tenantOf } from '@/lib/auth';
import { AppError, toErrorBody } from '@/lib/errors';
import { createLogger } from '@/lib/logger';
import { readTextLimited } from '@/lib/http/body';
import { audited } from '@/modules/audit/service';
import { replayCorrelation } from '@/modules/correlation/replay';
import { runCorrelation } from '@/modules/correlation/service';

export const dynamic = 'force-dynamic';

const log = createLogger('api.correlation.run');

const BodySchema = z
  .object({
    /** 仅调试用：用指定时刻作为聚合基准，便于复现历史窗口 */
    now: z.coerce.date().optional(),
    /** 与 to 成对出现：按告警自己的时间重放聚合，不改时间戳 */
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
  })
  .default({})
  .superRefine((value, ctx) => {
    const hasReplay = value.from !== undefined || value.to !== undefined;
    if (hasReplay && (value.from === undefined || value.to === undefined)) {
      ctx.addIssue({ code: 'custom', message: '回放需要同时给出 from 和 to', path: ['from'] });
    }
    if (hasReplay && value.now !== undefined) {
      ctx.addIssue({ code: 'custom', message: '回放不要再传 now', path: ['now'] });
    }
  });

/**
 * POST /api/v1/correlation/run
 * 手动触发聚合。幂等：重复调用不会产生重复事件（AC-04 / AC-17）。
 */
export async function POST(req: Request) {
  const traceId = crypto.randomUUID();
  try {
    const raw = (await readTextLimited(req)).trim();
    let body: unknown = {};
    if (raw.length > 0) {
      try {
        body = JSON.parse(raw);
      } catch {
        throw new AppError('VALIDATION_FAILED', '请求体不是合法 JSON');
      }
    }

    const parsed = BodySchema.safeParse(body);
    if (!parsed.success) {
      throw new AppError(
        'VALIDATION_FAILED',
        '请求体不合法：期望空 body、{ now?: ISO8601 }，或 { from, to }',
        parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`),
      );
    }

    const data = parsed.data;
    const replaying = data.from !== undefined && data.to !== undefined;
    const summary = await audited(
      req,
      {
        action: replaying ? 'correlation.replay' : 'correlation.run',
        target: replaying
          ? `${data.from!.toISOString()}..${data.to!.toISOString()}`
          : (data.now?.toISOString() ?? 'now'),
        detailOf: (r) => ({
          created: r.created.length,
          updated: r.updated.length,
          reopened: r.reopened.length,
          merged: r.merged.length,
          durationMs: r.durationMs,
        }),
        requestId: traceId,
      },
      async () => {
        if (replaying) {
          try {
            return await replayCorrelation({
              from: data.from!,
              to: data.to!,
              tenantId: tenantOf(req),
            });
          } catch (error) {
            throw new AppError(
              'VALIDATION_FAILED',
              error instanceof Error ? error.message : '回放参数不合法',
            );
          }
        }
        return runCorrelation(data.now, tenantOf(req));
      },
    );
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
