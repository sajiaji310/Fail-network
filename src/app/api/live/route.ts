import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/** 存活探针：不依赖数据库，进程能响应即 200。用于 K8s liveness / LB 健康检查。 */
export function GET() {
  return NextResponse.json({ status: 'ok' });
}
