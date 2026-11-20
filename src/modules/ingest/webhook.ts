import { NextResponse } from 'next/server';
import { actorOf, tenantOf } from '@/lib/auth';
import { AppError, toErrorBody } from '@/lib/errors';
import { readTextLimited } from '@/lib/http/body';
import { createLogger } from '@/lib/logger';
import { audited } from '@/modules/audit/service';
import { submitIngest } from './batch';
import { parseAlertmanager } from './sources/alertmanager';
import { parseZabbix } from './sources/zabbix';

/**
 * 真实数据源 webhook 的统一入口。
 *
 * 两个适配器共用的部分（读体、限长、审计、同步/异步分流）只写一次，
 * 差异全部收敛在 `parse*` 里 —— 以后加 Syslog / 钉钉告警只需要再补一个解析函数。
 */

const log = createLogger('api.ingest.webhook');
const MAX_BODY_BYTES = 4 * 1024 * 1024;

export type SourceKind = 'alertmanager' | 'zabbix';

const TARGET_LABEL: Record<SourceKind, string> = {
  alertmanager: 'Prometheus Alertmanager',
  zabbix: 'Zabbix',
};

export async function handleWebhook(req: Request, kind: SourceKind): Promise<Response> {
  const traceId = crypto.randomUUID();
  try {
    const text = await readTextLimited(req, MAX_BODY_BYTES);
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new AppError('VALIDATION_FAILED', '请求体不是合法 JSON');
    }

    const parsed = kind === 'alertmanager' ? parseAlertmanager(payload) : parseZabbix(payload);
    if (parsed.rows.length === 0) {
      throw new AppError(
        'VALIDATION_FAILED',
        parsed.skipped > 0
          ? `收到 ${parsed.skipped} 条已恢复告警，没有需要建事件的告警`
          : '没有可导入的告警',
        parsed.issues.slice(0, 20),
      );
    }

    const url = new URL(req.url);
    const source = url.searchParams.get('source') ?? kind;
    const tenantId = tenantOf(req);
    const createdBy = actorOf(req);

    const outcome = await audited(
      req,
      {
        action: 'alert.ingest',
        target: `${kind}:${source}`,
        detail: { rows: parsed.rows.length, skipped: parsed.skipped, adapter: kind },
        detailOf: (value) => ({ mode: value.mode }),
        requestId: traceId,
      },
      () =>
        submitIngest({
          source,
          kind,
          alerts: parsed.rows,
          tenantId,
          createdBy,
        }),
    );

    const issues = [...parsed.issues, ...('result' in outcome ? outcome.result.issues : [])].slice(
      0,
      50,
    );

    log.info('webhook_ingest', {
      traceId,
      kind,
      rows: parsed.rows.length,
      skipped: parsed.skipped,
      mode: outcome.mode,
    });

    if (outcome.mode === 'async') {
      return NextResponse.json(
        {
          mode: 'async',
          batchId: outcome.batchId,
          total: outcome.total,
          skipped: parsed.skipped,
          issues,
          source: `${TARGET_LABEL[kind]}（${source}）`,
        },
        { status: 202, headers: { 'x-trace-id': traceId, 'x-batch-id': outcome.batchId } },
      );
    }

    return NextResponse.json(
      { mode: 'sync', ...outcome.result, skipped: parsed.skipped, issues },
      { headers: { 'x-trace-id': traceId } },
    );
  } catch (error) {
    const { status, body } = toErrorBody(error);
    log.error('webhook_failed', { traceId, kind, err: String(error) });
    return NextResponse.json(body, { status, headers: { 'x-trace-id': traceId } });
  }
}
