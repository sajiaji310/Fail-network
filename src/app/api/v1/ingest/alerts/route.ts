import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createLogger } from '@/lib/logger';
import { toErrorBody, AppError } from '@/lib/errors';
import { parseCsv } from '@/modules/ingest/parsers/csv';
import { parseJson } from '@/modules/ingest/parsers/json';
import {
  IngestCsvBodySchema,
  IngestJsonBodySchema,
  type ParseResult,
} from '@/modules/ingest/schema';
import { ingestAlerts } from '@/modules/ingest/service';

export const dynamic = 'force-dynamic';

const log = createLogger('api.ingest.alerts');
const MAX_BODY_BYTES = 2 * 1024 * 1024;

const SourceOnly = z.object({ source: z.string().min(1).max(64) });

async function readInput(req: Request): Promise<{ source: string; parse: ParseResult }> {
  const contentType = req.headers.get('content-type') ?? '';
  const urlSource = new URL(req.url).searchParams.get('source');

  if (contentType.includes('text/csv') || contentType.includes('text/plain')) {
    const text = await req.text();
    return { source: urlSource ?? 'csv-upload', parse: parseCsv(text) };
  }

  const body: unknown = await req.json();

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
    const declared = Number(req.headers.get('content-length') ?? 0);
    if (declared > MAX_BODY_BYTES) {
      throw new AppError('VALIDATION_FAILED', '请求体超过 2MB 限制');
    }

    const { source, parse } = await readInput(req);

    if (parse.rows.length === 0) {
      throw new AppError('VALIDATION_FAILED', '没有可导入的告警行', parse.issues.slice(0, 20));
    }

    const result = await ingestAlerts(source, parse.rows);
    const issues = [...parse.issues, ...result.issues].slice(0, 50);

    log.info('ingest_done', {
      traceId,
      source,
      rows: parse.rows.length,
      accepted: result.accepted,
      deduped: result.deduped,
      failed: result.failed,
    });

    return NextResponse.json({ ...result, issues }, { headers: { 'x-trace-id': traceId } });
  } catch (error) {
    const { status, body } = toErrorBody(error);
    log.error('ingest_failed', { traceId, err: String(error) });
    return NextResponse.json(body, { status, headers: { 'x-trace-id': traceId } });
  }
}
