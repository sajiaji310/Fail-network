import { NextResponse } from 'next/server';
import { tenantOf } from '@/lib/auth';
import { toErrorBody } from '@/lib/errors';
import { getTopologyGraph } from '@/modules/topology/service';

export const dynamic = 'force-dynamic';

/** GET /api/v1/topology — 返回 { nodes, edges, stats }，可直接喂 React Flow */
export async function GET(req: Request) {
  const traceId = crypto.randomUUID();
  try {
    const graph = await getTopologyGraph(tenantOf(req));
    return NextResponse.json(graph, { headers: { 'x-trace-id': traceId } });
  } catch (error) {
    const { status, body } = toErrorBody(error);
    return NextResponse.json(body, { status, headers: { 'x-trace-id': traceId } });
  }
}
