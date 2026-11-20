import { NextResponse } from 'next/server';
import { z } from 'zod';
import { tenantOf } from '@/lib/auth';
import { AppError, toErrorBody } from '@/lib/errors';
import { querySamples, summarizeTrend } from '@/modules/metrics/service';

export const dynamic = 'force-dynamic';

const QuerySchema = z.object({
  deviceId: z.string().max(64).optional(),
  deviceName: z.string().max(120).optional(),
  metric: z.string().max(64).optional(),
  /** 相对时间窗：最近 N 分钟，与 from/to 二选一 */
  minutes: z.coerce.number().int().min(1).max(10_080).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(2000).default(500),
});

/**
 * GET /api/v1/metrics — 指标采样查询。
 *
 * 返回原始点 + 一个聚合趋势（首末/峰谷/斜率），页面和 RCA 调试都能直接用，
 * 不必各自再算一遍。
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

    const { minutes, from, to, ...rest } = parsed.data;
    const windowTo = to ?? new Date();
    const windowFrom =
      from ?? (minutes ? new Date(windowTo.getTime() - minutes * 60_000) : undefined);

    const { points, total } = await querySamples({
      ...rest,
      from: windowFrom,
      to: windowTo,
      tenantId: tenantOf(req),
    });

    const trend = summarizeTrend(points.map((p) => ({ at: p.at, value: p.value })));

    return NextResponse.json(
      {
        points,
        total,
        window: { from: windowFrom?.toISOString() ?? null, to: windowTo.toISOString() },
        trend,
      },
      { headers: { 'x-trace-id': traceId, 'cache-control': 'no-store' } },
    );
  } catch (error) {
    const { status, body } = toErrorBody(error);
    return NextResponse.json(body, { status, headers: { 'x-trace-id': traceId } });
  }
}
