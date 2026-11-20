import { NextResponse } from 'next/server';
import { z } from 'zod';
import { tenantOf } from '@/lib/auth';
import { AppError, toErrorBody } from '@/lib/errors';
import { listIncidents } from '@/modules/incidents/service';

export const dynamic = 'force-dynamic';

const IncidentStatusEnum = z.enum([
  'OPEN',
  'ANALYZING',
  'LOCATED',
  'MITIGATED',
  'RESOLVED',
  'CLOSED',
]);
const SeverityEnum = z.enum(['P0', 'P1', 'P2', 'P3']);

const QuerySchema = z.object({
  status: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').map((s) => s.trim().toUpperCase()) : undefined))
    .pipe(z.array(IncidentStatusEnum).optional()),
  severity: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').map((s) => s.trim().toUpperCase()) : undefined))
    .pipe(z.array(SeverityEnum).optional()),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

/** GET /api/v1/incidents?status=OPEN&severity=P0&page=1 */
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
    const result = await listIncidents({ ...parsed.data, tenantId: tenantOf(req) });
    return NextResponse.json(result, { headers: { 'x-trace-id': traceId } });
  } catch (error) {
    const { status, body } = toErrorBody(error);
    return NextResponse.json(body, { status, headers: { 'x-trace-id': traceId } });
  }
}
