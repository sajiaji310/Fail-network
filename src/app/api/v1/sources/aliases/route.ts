import { NextResponse } from 'next/server';
import { z } from 'zod';
import { actorOf, tenantOf } from '@/lib/auth';
import { AppError, toErrorBody } from '@/lib/errors';
import { readJsonLimited } from '@/lib/http/body';
import { db } from '@/lib/db';
import { recordAudit } from '@/modules/audit/service';

export const dynamic = 'force-dynamic';

const BodySchema = z.object({
  alias: z.string().min(1).max(120),
  deviceName: z.string().min(1).max(120),
  note: z.string().max(200).optional(),
});

/**
 * POST /api/v1/sources/aliases — 给设备加一个上游主机名别名。
 *
 * 存在的理由：真实接入的第一道坎不是协议，是"Prometheus 说 10.1.0.1:9100、
 * Zabbix 说 core-sw-01、而 CMDB 里叫 CORE-SW-01"。没有这个接口，用户只能去改
 * 数据源脚本或手写 SQL —— 两者都会在下次部署时丢掉。
 *
 * 路径以 /api/v1/sources 开头，按 RBAC 规则自动要求 ADMIN。
 */
export async function POST(req: Request) {
  const traceId = crypto.randomUUID();
  try {
    const body = await readJsonLimited(req, 8 * 1024);
    const parsed = BodySchema.safeParse(body);
    if (!parsed.success) {
      throw new AppError(
        'VALIDATION_FAILED',
        '参数不合法',
        parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`),
      );
    }

    const tenantId = tenantOf(req);
    const device = await db.device.findFirst({
      where: { tenantId, name: { equals: parsed.data.deviceName, mode: 'insensitive' } },
      select: { id: true, name: true },
    });
    if (!device) {
      throw new AppError('NOT_FOUND', `设备不存在：${parsed.data.deviceName}`);
    }

    const alias = parsed.data.alias.trim().toLowerCase();
    const existing = await db.deviceAlias.findUnique({
      where: { alias },
      select: { deviceId: true },
    });
    if (existing && existing.deviceId !== device.id) {
      throw new AppError('VALIDATION_FAILED', `别名已被其他设备占用：${alias}`);
    }

    const row = await db.deviceAlias.upsert({
      where: { alias },
      create: {
        alias,
        deviceId: device.id,
        source: 'MANUAL',
        note: parsed.data.note ?? null,
      },
      update: { deviceId: device.id, note: parsed.data.note ?? null },
      select: { id: true, alias: true },
    });

    await recordAudit({
      action: 'source.alias',
      actor: actorOf(req),
      target: row.alias,
      tenantId,
      requestId: traceId,
      detail: { alias: row.alias, device: device.name },
    });

    return NextResponse.json(
      { id: row.id, alias: row.alias, deviceName: device.name, tenantId },
      { status: 201, headers: { 'x-trace-id': traceId } },
    );
  } catch (error) {
    const { status, body } = toErrorBody(error);
    return NextResponse.json(body, { status, headers: { 'x-trace-id': traceId } });
  }
}
