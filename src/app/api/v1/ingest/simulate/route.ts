import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createLogger } from '@/lib/logger';
import { AppError, toErrorBody } from '@/lib/errors';
import { runScenario } from '@/modules/ingest/scenario';
import { resetDemoData } from '@/modules/ingest/reset';

export const dynamic = 'force-dynamic';

const log = createLogger('api.ingest.simulate');

const BodySchema = z.object({
  scenario: z.string().min(1).max(80),
  seed: z
    .number()
    .int()
    .min(0)
    .max(2 ** 31)
    .optional(),
  /** 先清空注入/聚合产生的数据再注入：逐个剧本验收时必须置 true，否则会并成 mega 事件 */
  reset: z.boolean().optional(),
});

export async function POST(req: Request) {
  const traceId = crypto.randomUUID();
  try {
    const parsed = BodySchema.safeParse(await req.json());
    if (!parsed.success) {
      throw new AppError(
        'VALIDATION_FAILED',
        '请求体不合法：期望 { scenario, seed? }',
        parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`),
      );
    }

    const { scenario, seed, reset } = parsed.data;
    const resetSummary = reset ? await resetDemoData() : null;
    let result;
    try {
      result = await runScenario(scenario, seed);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('剧本名不合法')) {
        throw new AppError('VALIDATION_FAILED', error.message);
      }
      throw new AppError('NOT_FOUND', `剧本不存在：${scenario}`);
    }

    log.info('simulate_done', {
      traceId,
      scenario,
      accepted: result.ingest.accepted,
      deduped: result.ingest.deduped,
    });

    return NextResponse.json(
      {
        scenario: result.scenario,
        title: result.title,
        runId: result.runId,
        alertTotal: result.alertTotal,
        changes: result.changes,
        reset: resetSummary,
        accepted: result.ingest.accepted,
        deduped: result.ingest.deduped,
        suppressed: result.ingest.suppressed,
        failed: result.ingest.failed,
        incidentIds: result.incidentIds,
        incidentId: result.incidentIds[0] ?? null,
        correlation: {
          created: result.correlation.created.length,
          updated: result.correlation.updated.length,
          reopened: result.correlation.reopened.length,
          durationMs: result.correlation.durationMs,
        },
        traceId,
      },
      { headers: { 'x-trace-id': traceId } },
    );
  } catch (error) {
    const { status, body } = toErrorBody(error);
    log.error('simulate_failed', { traceId, err: String(error) });
    return NextResponse.json(body, { status, headers: { 'x-trace-id': traceId } });
  }
}
