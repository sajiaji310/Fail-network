/**
 * 种子数据：30 设备（1 核心 / 4 汇聚 / 25 接入）+ 60 链路 + 30 条已结案历史案例。
 * 每条历史案例挂 3 条已恢复告警，列表不再是「告警 0 · 设备 0」。
 * 幂等：全部 upsert，重复执行条数不变。
 * 确定性：时间基于固定基准日，不用 new Date()。
 */
import { loadEnvFile } from 'node:process';
import { PrismaClient } from '@prisma/client';
import { signatureOf } from '../src/modules/alerts/fingerprint';
import { SLA_TARGET_MINUTES } from '../src/modules/incidents/sla';
import {
  ACC_NAMES,
  AGG_NAMES,
  ALIASES,
  CASES,
  DEVICES,
  METRIC_SERIES,
  ONCALL,
  SERVICES,
} from './seed-data';

try {
  loadEnvFile('.env');
} catch {
  // .env 已由外部注入（CI / docker）时无需加载
}

const db = new PrismaClient();
const TENANT = 'default';

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
      where: { tenantId_name: { tenantId: TENANT, name: d.name } },
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

async function seedServices() {
  const rows = await db.device.findMany({ select: { id: true, name: true } });
  const idByName = new Map(rows.map((r) => [r.name, r.id]));

  for (const s of SERVICES) {
    const service = await db.service.upsert({
      where: { code: s.code },
      create: { code: s.code, name: s.name, tier: s.tier, owner: s.owner, note: s.note },
      update: { name: s.name, tier: s.tier, owner: s.owner, note: s.note },
    });

    for (const dep of s.devices) {
      const deviceId = idByName.get(dep.name);
      if (!deviceId) throw new Error(`服务 ${s.code} 依赖的设备不存在：${dep.name}`);
      await db.serviceDevice.upsert({
        where: { serviceId_deviceId: { serviceId: service.id, deviceId } },
        create: { serviceId: service.id, deviceId, role: dep.role },
        update: { role: dep.role },
      });
    }
  }
}

/** 默认租户：API Key 的 tenant 字段要指向一个真实存在的行，而不是靠字符串约定 */
async function seedTenant() {
  await db.tenant.upsert({
    where: { id: 'default' },
    create: { id: 'default', name: '默认租户' },
    update: { name: '默认租户' },
  });
}

async function seedAliases() {
  for (const a of ALIASES) {
    const device = await db.device.findUnique({
      where: { tenantId_name: { tenantId: TENANT, name: a.device } },
      select: { id: true },
    });
    if (!device) {
      console.warn(`[seed] 别名跳过（设备不存在）：${a.alias} → ${a.device}`);
      continue;
    }
    await db.deviceAlias.upsert({
      where: { tenantId_alias: { tenantId: TENANT, alias: a.alias } },
      create: {
        alias: a.alias,
        deviceId: device.id,
        tenantId: TENANT,
        source: a.source,
        note: a.note,
      },
      update: { deviceId: device.id, source: a.source, note: a.note },
    });
  }
}

/**
 * 指标采样：最近 6 小时、每 15 分钟一个点，值随时间线性爬升。
 *
 * 时间戳按 15 分钟对齐再写入（唯一键含 at），因此同一刻内重复执行种子不会堆点；
 * 但跨过整点后重跑会补出新的窗口 —— 指标本来就是时间相对的，这点和「案例用固定基准日」
 * 不同，刻意如此。
 */
async function seedMetrics() {
  const stepMs = 15 * 60_000;
  const lastBucket = Math.floor(Date.now() / stepMs) * stepMs;
  const points = 25;

  for (const series of METRIC_SERIES) {
    const device = await db.device.findUnique({
      where: { tenantId_name: { tenantId: TENANT, name: series.device } },
      select: { id: true },
    });
    if (!device) continue;

    const rows = Array.from({ length: points }, (_, index) => {
      const at = new Date(lastBucket - (points - 1 - index) * stepMs);
      // 叠加一点确定性波动，避免曲线是完美直线（否则看不出"斜率"这件事的意义）
      const wave = Math.sin(index / 3) * series.step * 0.6;
      return {
        deviceId: device.id,
        metric: series.metric,
        value: Math.round((series.base + series.step * index + wave) * 100) / 100,
        unit: series.unit,
        at,
        source: 'seed',
        tenantId: 'default',
      };
    });

    await db.metricSample.createMany({ data: rows, skipDuplicates: true });
  }
}

type CaseCategory = (typeof CASES)[number]['category'];

/** 每条历史案例 3 条已恢复告警，类型跟着根因类别走，避免列表全是同一种 */
const CASE_ALERT_TYPES: Record<CaseCategory, [string, string, string]> = {
  HARDWARE: ['DEVICE_UNREACHABLE', 'LINK_DOWN', 'PORT_FLAP'],
  CONFIG: ['CONFIG_CHANGE', 'LINK_DOWN', 'PACKET_LOSS'],
  LINK: ['LINK_DOWN', 'PACKET_LOSS', 'PORT_FLAP'],
  CAPACITY: ['CPU_HIGH', 'HIGH_LATENCY', 'PACKET_LOSS'],
  UPSTREAM: ['DEVICE_UNREACHABLE', 'HIGH_LATENCY', 'PACKET_LOSS'],
  OTHER: ['LINK_DOWN', 'PACKET_LOSS', 'CPU_HIGH'],
};

/** 从案例正文里抽出设备名；`AGG-SW-03/04` 记成两台。没有点名就按序号落到接入交换机 */
function devicesForCase(text: string, index: number, known: Map<string, string>): string[] {
  const named = new Set<string>();
  for (const match of text.matchAll(/(CORE|AGG|ACC)-SW-(\d{2})(?:\/(\d{2}))?/g)) {
    named.add(`${match[1]}-SW-${match[2]}`);
    if (match[3]) named.add(`${match[1]}-SW-${match[3]}`);
  }
  const existing = [...named].filter((name) => known.has(name));
  if (existing.length > 0) return existing.slice(0, 3);
  return [ACC_NAMES[index % ACC_NAMES.length]!];
}

async function attachSeedAlerts(
  incidentId: string,
  code: string,
  spec: (typeof CASES)[number],
  index: number,
  startedAtMs: number,
  resolvedAt: Date,
  idByName: Map<string, string>,
) {
  const names = devicesForCase(`${spec.symptom}\n${spec.rootCause}`, index, idByName);
  const types = CASE_ALERT_TYPES[spec.category];
  for (let i = 0; i < types.length; i++) {
    const deviceName = names[Math.min(i, names.length - 1)]!;
    const deviceId = idByName.get(deviceName);
    if (!deviceId) throw new Error(`种子告警设备不存在：${deviceName}`);
    const type = types[i]!;
    const firstSeen = new Date(startedAtMs + i * 60_000);
    const signature = signatureOf(deviceId, type, 'seed');
    const fingerprint = await db.alertFingerprint.upsert({
      where: { signature },
      create: { signature, deviceId, type, metric: 'seed', severity: spec.severity },
      update: { severity: spec.severity },
    });
    const externalKey = `seed:${code}:${i}`;
    await db.alert.upsert({
      where: { tenantId_externalKey: { tenantId: TENANT, externalKey } },
      create: {
        fingerprintId: fingerprint.id,
        tenantId: TENANT,
        severity: spec.severity,
        message: `${deviceName} ${type}：${spec.title}`,
        status: 'RESOLVED',
        count: 1,
        firstSeen,
        lastSeen: resolvedAt,
        cycleStart: firstSeen,
        externalKey,
        incidentId,
      },
      update: {
        fingerprintId: fingerprint.id,
        severity: spec.severity,
        message: `${deviceName} ${type}：${spec.title}`,
        status: 'RESOLVED',
        firstSeen,
        lastSeen: resolvedAt,
        cycleStart: firstSeen,
        incidentId,
      },
    });
  }
}

async function seedCases() {
  const devices = await db.device.findMany({
    where: { tenantId: TENANT },
    select: { id: true, name: true },
  });
  const idByName = new Map(devices.map((d) => [d.name, d.id]));
  const seqByDay = new Map<string, number>();

  for (const [index, c] of CASES.entries()) {
    const startedAtMs = BASE - c.daysAgo * DAY + (index % 7) * 900_000;
    const code = codeFor(startedAtMs, seqByDay);
    const locatedAt = new Date(startedAtMs + c.locateMin * 60_000);
    const resolvedAt = new Date(startedAtMs + c.resolveMin * 60_000);
    // 历史事件一律有归属：否则「未接手」队列里塞满三个月前的陈账，
    // 演示时看不出"当前有没有人管"这件事
    const oncall = ONCALL[index % ONCALL.length]!;
    const claimedAt = new Date(startedAtMs + (2 + (index % 9)) * 60_000);

    const incident = await db.incident.upsert({
      where: { tenantId_code: { tenantId: TENANT, code } },
      create: {
        code,
        tenantId: TENANT,
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
        assignee: oncall.assignee,
        team: oncall.team,
        claimedAt,
        slaMinutes: SLA_TARGET_MINUTES[c.severity],
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
        assignee: oncall.assignee,
        team: oncall.team,
        claimedAt,
        slaMinutes: SLA_TARGET_MINUTES[c.severity],
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

    await attachSeedAlerts(incident.id, code, c, index, startedAtMs, resolvedAt, idByName);
  }
}

async function main() {
  console.log('[seed] 开始…');
  await seedTenant();
  await seedDevices();
  await seedLinks();
  await seedServices();
  await seedAliases();
  await seedMetrics();
  await seedCases();

  const [devices, links, incidents, cases, services, aliases, samples, seedAlerts, byLayer] =
    await Promise.all([
      db.device.count(),
      db.topologyLink.count(),
      db.incident.count(),
      db.caseRecord.count(),
      db.service.count(),
      db.deviceAlias.count(),
      db.metricSample.count(),
      db.alert.count({ where: { externalKey: { startsWith: 'seed:' } } }),
      db.device.groupBy({ by: ['layer'], _count: { _all: true }, orderBy: { layer: 'asc' } }),
    ]);

  console.log(
    `[seed] 设备 ${devices} · 链路 ${links} · 事件 ${incidents} · 案例 ${cases} · 服务 ${services} · 别名 ${aliases} · 指标采样 ${samples} · 历史告警 ${seedAlerts}`,
  );
  console.log(
    `[seed] 层级分布 ${byLayer.map((g) => `L${g.layer}:${g._count._all}`).join(' / ')}（期望 L1:1 / L2:4 / L3:25）`,
  );
  console.log('[seed] 期望基线 30 / 60 / 30 / 30 / 6 / 4，历史告警 90');

  const ok =
    devices === 30 &&
    links === 60 &&
    cases === 30 &&
    services === SERVICES.length &&
    aliases === ALIASES.length &&
    seedAlerts === CASES.length * 3;
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
