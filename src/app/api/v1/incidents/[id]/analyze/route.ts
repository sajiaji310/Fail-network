import { NextResponse } from 'next/server';
import { AppError, toErrorBody } from '@/lib/errors';
import { createLogger } from '@/lib/logger';
import { runAnalysis } from '@/modules/rca/analyze';

export const dynamic = 'force-dynamic';
/** 模型调用最长 30s + 一次修复重试，给足余量，别让平台默认值把请求掐断 */
export const maxDuration = 60;

const log = createLogger('api.analyze');

/**
 * POST /api/v1/incidents/[id]/analyze — AI 研判
 *
 * MVP-0 是同步返回（文档 10.4：P1 才换 SSE）。5 分钟内重复调用直接回缓存，
 * `?force=1` 或 body `{force:true}` 才重算。
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const traceId = crypto.randomUUID();
  try {
    const { id } = await ctx.params;
    const url = new URL(req.url);
    const body = (await req.json().catch(() => ({}))) as { force?: unknown };
    const force = url.searchParams.get('force') === '1' || body.force === true;

    const outcome = await runAnalysis(id, { force });
    if (!outcome) {
      throw new AppError('NOT_FOUND', `事件不存在：${id}`);
    }

    log.info('analyze_done', {
      traceId,
      code: outcome.code,
      source: outcome.source,
      cached: outcome.cached,
    });

    return NextResponse.json(outcome, { headers: { 'x-trace-id': traceId } });
  } catch (error) {
    const { status, body } = toErrorBody(error);
    log.error('analyze_failed', { traceId, err: String(error) });
    return NextResponse.json(body, { status, headers: { 'x-trace-id': traceId } });
  }
}
