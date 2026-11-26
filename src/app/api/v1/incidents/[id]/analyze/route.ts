import { NextResponse } from 'next/server';
import { z } from 'zod';
import { tenantOf } from '@/lib/auth';
import { AppError, toErrorBody } from '@/lib/errors';
import { createLogger } from '@/lib/logger';
import { readJsonLimited } from '@/lib/http/body';
import { audited } from '@/modules/audit/service';
import { runAnalysis } from '@/modules/rca/analyze';

export const dynamic = 'force-dynamic';
/** 模型调用最长 30s + 一次修复重试，给足余量，别让平台默认值把请求掐断 */
export const maxDuration = 60;

const log = createLogger('api.analyze');

/** 显式校验而不是 `body.force === true` 的宽转：写错字段名要报错，不能静默降级成"不强制" */
const BodySchema = z.object({ force: z.boolean().optional() }).default({});

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

    const parsed = BodySchema.safeParse((await readJsonLimited(req)) ?? {});
    if (!parsed.success) {
      throw new AppError(
        'VALIDATION_FAILED',
        '请求体不合法：期望 { force?: boolean }',
        parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`),
      );
    }
    const force = url.searchParams.get('force') === '1' || parsed.data.force === true;

    const outcome = await audited(
      req,
      { action: 'analyze.run', target: id, detail: { force }, requestId: traceId },
      async () => {
        const result = await runAnalysis(id, { force, tenantId: tenantOf(req) });
        if (!result) {
          throw new AppError('NOT_FOUND', `事件不存在：${id}`);
        }
        return result;
      },
    );

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
