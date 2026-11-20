/**
 * 种子数据：30 设备（1 核心 / 4 汇聚 / 25 接入）+ 60 链路 + 30 条已结案历史案例
 * 幂等：全部 upsert，重复执行条数不变
 * 确定性：时间基于固定基准日，不用 new Date()
 */
import { loadEnvFile } from 'node:process';
import { PrismaClient } from '@prisma/client';
import { ACC_NAMES, AGG_NAMES, CASES, DEVICES } from './seed-data';

try {
  loadEnvFile('.env');
} catch {
  // .env 已由外部注入（CI / docker）时无需加载
}

const db = new PrismaClient();

const BASE = Date.UTC(2026, 10, 1, 1, 0, 0); // 2026-11-01T09:00+08:00
const DAY = 86_400_000;

type LinkSpec = { source: string; target: string; bandwidth: number };

/** 4 核心-汇聚 + 3 汇聚链 + 50 接入双归属 + 3 堆叠 = 60 */
function buildLinks(): LinkSpec[] {
  const links: LinkSpec[] = [];

  for (const agg of AGG_NAMES) {
    links.push({ source: 'CORE-SW-01', target: agg, bandwidth: 10000 });
  }
  // 汇聚串成链而非环：保证部分设备对拓扑距离 > 2 跳，B7 才有可测场景
  links.push({ source: 'AGG-SW-01', target: 'AGG-SW-02', bandwidth: 10000 });
  links.push({ source: 'AGG-SW-02', target: 'AGG-SW-03', bandwidth: 10000 });
  links.push({ source: 'AGG-SW-03', target: 'AGG-SW-04', bandwidth: 10000 });

  for (let i = 0; i < ACC_NAMES.length; i++) {
    const primary = AGG_NAMES[i % AGG_NAMES.length]!;
    const secondary = AGG_NAMES[(i + 1) % AGG_NAMES.length]!;
    links.push({ source: primary, target: ACC_NAMES[i]!, bandwidth: 1000 });
    links.push({ source: secondary, target: ACC_NAMES[i]!, bandwidth: 1000 });
  }
  // 堆叠互联
  links.push({ source: 'ACC-SW-01', target: 'ACC-SW-02', bandwidth: 1000 });
  links.push({ source: 'ACC-SW-03', target: 'ACC-SW-04', bandwidth: 1000 });
  links.push({ source: 'ACC-SW-05', target: 'ACC-SW-06', bandwidth: 1000 });

  return links;
}

function codeFor(startedAt: number, seqByDay: Map<string, number>): string {
  const shanghai = new Date(startedAt + 8 * 3600_000).toISOString().slice(0, 10).replace(/-/g, '');
  const seq = (seqByDay.get(shanghai) ?? 0) + 1;
  seqByDay.set(shanghai, seq);
  return `INC-${shanghai}-${String(seq).padStart(3, '0')}`;
}

async function seedDevices() {
  for (const d of DEVICES) {
    await db.device.upsert({
      where: { name: d.name },
      create: d,
      update: {
        type: d.type,
        layer: d.layer,
        site: d.site,
        vendor: d.vendor,
        model: d.model,
        ip: d.ip,
      },
    });
  }
}

async function seedLinks() {
  const rows = await db.device.findMany({ select: { id: true, name: true } });
  const idByName = new Map(rows.map((r) => [r.name, r.id]));

  for (const link of buildLinks()) {
    const sourceId = idByName.get(link.source);
    const targetId = idByName.get(link.target);
    if (!sourceId || !targetId) throw new Error(`链路端点不存在：${link.source} / ${link.target}`);

    await db.topologyLink.upsert({
      where: { sourceId_targetId: { sourceId, targetId } },
      create: { sourceId, targetId, bandwidth: link.bandwidth, status: 'UP' },
      update: { bandwidth: link.bandwidth, status: 'UP' },
    });
  }
}

async function seedCases() {
  const seqByDay = new Map<string, number>();

  for (const [index, c] of CASES.entries()) {
    const startedAtMs = BASE - c.daysAgo * DAY + (index % 7) * 900_000;
    const code = codeFor(startedAtMs, seqByDay);
    const locatedAt = new Date(startedAtMs + c.locateMin * 60_000);
    const resolvedAt = new Date(startedAtMs + c.resolveMin * 60_000);

    const incident = await db.incident.upsert({
      where: { code },
      create: {
        code,
        title: c.title,
        status: 'CLOSED',
        severity: c.severity,
        summary: c.rootCause,
        impactScope: c.symptom.split(/[，。]/)[0]!.slice(0, 60),
        startedAt: new Date(startedAtMs),
        lastSeen: resolvedAt,
        locatedAt,
        resolvedAt,
        mttrSeconds: c.resolveMin * 60,
        closedReason: 'MANUAL',
      },
      update: {
        title: c.title,
        severity: c.severity,
        summary: c.rootCause,
        startedAt: new Date(startedAtMs),
        lastSeen: resolvedAt,
        locatedAt,
        resolvedAt,
        mttrSeconds: c.resolveMin * 60,
        status: 'CLOSED',
      },
    });

    await db.caseRecord.upsert({
      where: { incidentId: incident.id },
      create: {
        incidentId: incident.id,
        title: c.title,
        symptom: c.symptom,
        rootCause: c.rootCause,
        resolution: c.resolution,
        tags: [...c.tags, c.category],
        // 种子案例是人工整理的「正确经验」，等同于确认过的案例 ——
        // 不标 VERIFIED 的话它们不会进入研判召回，演示里就没有历史案例信号了
        verification: 'VERIFIED',
        verifiedAt: new Date(),
        verifiedBy: 'seed',
        verifyNote: '演示基线数据（人工整理）',
      },
      update: {
        title: c.title,
        symptom: c.symptom,
        rootCause: c.rootCause,
        resolution: c.resolution,
        tags: [...c.tags, c.category],
        verification: 'VERIFIED',
        verifiedAt: new Date(),
        verifiedBy: 'seed',
        verifyNote: '演示基线数据（人工整理）',
      },
    });
  }
}

async function main() {
  console.log('[seed] 开始…');
  await seedDevices();
  await seedLinks();
  await seedCases();

  const [devices, links, incidents, cases, byLayer] = await Promise.all([
    db.device.count(),
    db.topologyLink.count(),
    db.incident.count(),
    db.caseRecord.count(),
    db.device.groupBy({ by: ['layer'], _count: { _all: true }, orderBy: { layer: 'asc' } }),
  ]);

  console.log(`[seed] 设备 ${devices} · 链路 ${links} · 事件 ${incidents} · 案例 ${cases}`);
  console.log(
    `[seed] 层级分布 ${byLayer.map((g) => `L${g.layer}:${g._count._all}`).join(' / ')}（期望 L1:1 / L2:4 / L3:25）`,
  );
  console.log('[seed] 期望基线 30 / 60 / 30 / 30');

  const ok = devices === 30 && links === 60 && cases === 30;
  if (!ok) {
    console.error('[seed] 数量与基线不一致，检查 upsert 唯一键');
    process.exitCode = 1;
  }
}

main()
  .catch((e) => {
    console.error('[seed] 失败：', e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
