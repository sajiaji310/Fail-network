import { NextResponse } from 'next/server';
import { toErrorBody } from '@/lib/errors';
import { getTopologyGraph } from '@/modules/topology/service';

export const dynamic = 'force-dynamic';

/** GET /api/v1/topology — 返回 { nodes, edges, stats }，可直接喂 React Flow */
export async function GET() {
  const traceId = crypto.randomUUID();
  try {
    const graph = await getTopologyGraph();
    return NextResponse.json(graph, { headers: { 'x-trace-id': traceId } });
  } catch (error) {
    const { status, body } = toErrorBody(error);
    return NextResponse.json(body, { status, headers: { 'x-trace-id': traceId } });
  }
}
