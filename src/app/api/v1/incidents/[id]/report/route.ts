import { NextResponse } from 'next/server';
import { AppError, toErrorBody } from '@/lib/errors';
import { readJsonLimited } from '@/lib/http/body';
import { audited } from '@/modules/audit/service';
import { generateReport, getLatestReport } from '@/modules/report/service';

export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/incidents/[id]/report — 生成复盘报告（文档 9 节第 16 条：返回 markdown 文本）。
 *
 * 刻意返回 text/markdown 而不是包一层 JSON：这份文本的用法是
 * `curl .../report > inc.md` 或直接全选复制，包一层就得再解析一次。
 * 报告 id 放在 x-report-id 头里，前端需要时能拿到。
 *
 * `?save=0` 只生成不落库（预览用）。
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const traceId = crypto.randomUUID();
  try {
    const { id } = await ctx.params;
    const url = new URL(req.url);
    const save = url.searchParams.get('save') !== '0';
    const body = (await readJsonLimited(req)) as { note?: unknown } | null;
    const note = typeof body?.note === 'string' ? body.note : null;

    const report = await audited(
      req,
      {
        action: 'report.generate',
        target: id,
        detail: { save },
        detailOf: (r) => ({ code: r.code, charCount: r.charCount, reportId: r.reportId }),
        requestId: traceId,
      },
      async () => {
        const generated = await generateReport(id, { save, note });
        if (!generated) {
          throw new AppError('NOT_FOUND', `事件不存在：${id}`);
        }
        return generated;
      },
    );

    return new NextResponse(report.markdown, {
      headers: {
        'content-type': 'text/markdown; charset=utf-8',
        'x-trace-id': traceId,
        'x-incident-code': report.code,
        'x-report-id': report.reportId ?? '',
        'x-char-count': String(report.charCount),
      },
    });
  } catch (error) {
    const { status, body } = toErrorBody(error);
    return NextResponse.json(body, { status, headers: { 'x-trace-id': traceId } });
  }
}

/** GET /api/v1/incidents/[id]/report — 最近一次落库的报告，没有则 404 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const traceId = crypto.randomUUID();
  try {
    const { id } = await ctx.params;
    const report = await getLatestReport(id);
    if (!report) {
      throw new AppError('NOT_FOUND', '该事件还没有生成过报告，请先 POST 生成');
    }
    return new NextResponse(report.markdown, {
      headers: {
        'content-type': 'text/markdown; charset=utf-8',
        'x-trace-id': traceId,
        'x-report-id': report.id,
        'x-report-created-at': report.createdAt,
      },
    });
  } catch (error) {
    const { status, body } = toErrorBody(error);
    return NextResponse.json(body, { status, headers: { 'x-trace-id': traceId } });
  }
}
