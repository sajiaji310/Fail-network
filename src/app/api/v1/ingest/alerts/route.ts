import { NextResponse } from 'next/server';
import { z } from 'zod';
import { actorOf, tenantOf } from '@/lib/auth';
import { createLogger } from '@/lib/logger';
import { toErrorBody, AppError } from '@/lib/errors';
import { readTextLimited } from '@/lib/http/body';
import { audited } from '@/modules/audit/service';
import { submitIngest } from '@/modules/ingest/batch';
import { parseCsv } from '@/modules/ingest/parsers/csv';
import { parseJson } from '@/modules/ingest/parsers/json';
import { IngestCsvBodySchema, IngestJsonBodySchema } from '@/modules/ingest/schema';

export const dynamic = 'force-dynamic';

const log = createLogger('api.ingest.alerts');
const MAX_BODY_BYTES = 2 * 1024 * 1024;

const SourceOnly = z.object({ source: z.string().min(1).max(64) });

function readInput(text: string, contentType: string, urlSource: string | null) {
  if (contentType.includes('text/csv') || contentType.includes('text/plain')) {
    return { source: urlSource ?? 'csv-upload', parse: parseCsv(text) };
  }

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new AppError('VALIDATION_FAILED', '请求体不是合法 JSON');
  }

  const jsonBody = IngestJsonBodySchema.safeParse(body);
  if (jsonBody.success) {
    return { source: jsonBody.data.source, parse: parseJson(jsonBody.data.alerts) };
  }

  const csvBody = IngestCsvBodySchema.safeParse(body);
  if (csvBody.success) {
    return { source: csvBody.data.source, parse: parseCsv(csvBody.data.data) };
  }

  const sourceOnly = SourceOnly.safeParse(body);
  if (sourceOnly.success) {
    throw new AppError('VALIDATION_FAILED', `缺少 alerts 数组（source=${sourceOnly.data.source}）`);
  }

  throw new AppError(
    'VALIDATION_FAILED',
    '请求体不合法：期望 { source, alerts:[...] } 或 { source, format:"csv", data }',
    jsonBody.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`),
  );
}

export async function POST(req: Request) {
  const traceId = crypto.randomUUID();
  try {
    const contentType = req.headers.get('content-type') ?? '';
    const urlSource = new URL(req.url).searchParams.get('source');
    // 边读边计数：chunked 上传也能在超限瞬间断开，不靠 Content-Length 自证
    const text = await readTextLimited(req, MAX_BODY_BYTES);

    const { source, parse } = readInput(text, contentType, urlSource);

    if (parse.rows.length === 0) {
      throw new AppError('VALIDATION_FAILED', '没有可导入的告警行', parse.issues.slice(0, 20));
    }

    const outcome = await audited(
      req,
      {
        action: 'alert.ingest',
        target: source,
        detail: { rows: parse.rows.length },
        detailOf: (value) => ({ mode: value.mode }),
        requestId: traceId,
      },
      () =>
        submitIngest({
          source,
          kind:
            contentType.includes('text/csv') || contentType.includes('text/plain') ? 'csv' : 'json',
          alerts: parse.rows,
          tenantId: tenantOf(req),
          createdBy: actorOf(req),
        }),
    );

    if (outcome.mode === 'async') {
      log.info('ingest_queued', { traceId, source, rows: parse.rows.length });
      return NextResponse.json(
        {
          mode: 'async',
          batchId: outcome.batchId,
          total: outcome.total,
          issues: parse.issues.slice(0, 50),
        },
        {
          status: 202,
          headers: { 'x-trace-id': traceId, 'x-batch-id': outcome.batchId },
        },
      );
    }

    const result = outcome.result;
    const issues = [...parse.issues, ...result.issues].slice(0, 50);

    log.info('ingest_done', {
      traceId,
      source,
      rows: parse.rows.length,
      accepted: result.accepted,
      deduped: result.deduped,
      failed: result.failed,
    });

    return NextResponse.json(
      { mode: 'sync', ...result, issues },
      { headers: { 'x-trace-id': traceId } },
    );
  } catch (error) {
    const { status, body } = toErrorBody(error);
    log.error('ingest_failed', { traceId, err: String(error) });
    return NextResponse.json(body, { status, headers: { 'x-trace-id': traceId } });
  }
}
