import { NextResponse } from 'next/server';
import { z } from 'zod';
import { assertRole, tenantOf } from '@/lib/auth';
import { AppError, toErrorBody } from '@/lib/errors';
import { audited } from '@/modules/audit/service';
import { getRetentionPolicy, runRetention } from '@/modules/system/retention';

export const dynamic = 'force-dynamic';

const BodySchema = z.object({ dryRun: z.boolean().default(true) }).default({ dryRun: true });

/** GET /api/v1/admin/retention — 当前策略（只读，页面直接渲染） */
export async function GET(req: Request) {
  try {
    assertRole(req, 'GET', '/api/v1/admin/retention');
    return NextResponse.json(
      { policy: getRetentionPolicy() },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (error) {
    const { status, body } = toErrorBody(error);
    return NextResponse.json(body, { status });
  }
}

/**
 * POST /api/v1/admin/retention — 执行清理，默认 dryRun。
 *
 * 默认 dryRun=true 是刻意的：这个接口能删掉半年的审计与事件附属数据，
 * 调试时手滑一次代价太大。要真删必须显式传 `{"dryRun": false}`。
 */
export async function POST(req: Request) {
  const traceId = crypto.randomUUID();
  try {
    assertRole(req, 'POST', '/api/v1/admin/retention');
    const raw = await req.text();
    let payload: unknown = {};
    if (raw.trim().length > 0) {
      try {
        payload = JSON.parse(raw);
      } catch {
        throw new AppError('VALIDATION_FAILED', '请求体不是合法 JSON');
      }
    }
    const parsed = BodySchema.safeParse(payload);
    if (!parsed.success) {
      throw new AppError(
        'VALIDATION_FAILED',
        '参数不合法',
        parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`),
      );
    }

    const report = await audited(
      req,
      {
        action: 'retention.run',
        target: tenantOf(req),
        detail: { dryRun: parsed.data.dryRun },
        detailOf: (value) => ({ ...value.deleted }),
        requestId: traceId,
      },
      () => runRetention({ dryRun: parsed.data.dryRun }),
    );

    return NextResponse.json(report, { headers: { 'x-trace-id': traceId } });
  } catch (error) {
    const { status, body } = toErrorBody(error);
    return NextResponse.json(body, { status, headers: { 'x-trace-id': traceId } });
  }
}
