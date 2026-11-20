import { NextResponse } from 'next/server';
import { z } from 'zod';
import { actorOf, tenantOf } from '@/lib/auth';
import { AppError, toErrorBody } from '@/lib/errors';
import { readTextLimited } from '@/lib/http/body';
import { audited } from '@/modules/audit/service';
import { recordSamples } from '@/modules/metrics/service';

export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 4 * 1024 * 1024;

const BodySchema = z.object({
  samples: z
    .array(
      z.object({
        deviceName: z.string().min(1).max(120),
        metric: z.string().min(1).max(64),
        value: z.number().finite(),
        unit: z.string().max(16).nullish(),
        at: z.coerce.date(),
        source: z.string().min(1).max(32).optional(),
        labels: z.record(z.unknown()).nullish(),
      }),
    )
    .min(1)
    .max(5000),
});

/**
 * POST /api/v1/metrics/samples — 指标采样批量写入。
 *
 * 形状故意保持平坦：Prometheus 用 remote-write 协议（protobuf），在这里解析它成本太高，
 * 由采集侧用一个 10 行的 shim 转成 JSON 更实际；Zabbix / Telegraf 也都能直接吐这个结构。
 */
export async function POST(req: Request) {
  const traceId = crypto.randomUUID();
  try {
    const text = await readTextLimited(req, MAX_BODY_BYTES);
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new AppError('VALIDATION_FAILED', '请求体不是合法 JSON');
    }

    const parsed = BodySchema.safeParse(payload);
    if (!parsed.success) {
      throw new AppError(
        'VALIDATION_FAILED',
        '指标采样格式不合法',
        parsed.error.issues.slice(0, 20).map((i) => `${i.path.join('.') || 'body'}: ${i.message}`),
      );
    }

    const result = await audited(
      req,
      {
        action: 'metric.ingest',
        target: parsed.data.samples[0]?.source ?? 'metric-push',
        detail: { rows: parsed.data.samples.length },
        detailOf: (value) => ({ accepted: value.accepted, skipped: value.skipped }),
        requestId: traceId,
      },
      () => recordSamples(parsed.data.samples, tenantOf(req)),
    );

    return NextResponse.json(
      { ...result, submittedBy: actorOf(req) },
      { headers: { 'x-trace-id': traceId } },
    );
  } catch (error) {
    const { status, body } = toErrorBody(error);
    return NextResponse.json(body, { status, headers: { 'x-trace-id': traceId } });
  }
}
