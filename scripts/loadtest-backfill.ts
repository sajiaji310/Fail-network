import { loadEnvFile } from 'node:process';
import { db } from '../src/lib/db';

try {
  loadEnvFile('.env');
} catch {
  // 容器内用环境变量注入时没有 .env，忽略
}

/**
 * 真实环境回填压测（评审第 4 阶段「用真实环境一批 ≥1 万条告警回填一次」）。
 *
 * 这个脚本回答三个数字，而不是"跑起来没报错"：
 * 1. **批次耗时**：一批 4000 行要多久、吞吐多少条/秒；
 * 2. **去重率**：上游重复上报被合掉的占比（真实回填里这一项决定了库里留多少噪声）；
 * 3. **「设备不存在」占比**：接入期的主要成本，别名表补到什么程度算够。
 *
 * 三个真实约束决定了脚本的形状，别照抄成"一次 POST 十万条"：
 * - `IngestJsonBodySchema.alerts` 上限 5000 条/请求；
 * - 请求体 2 MB（`readTextLimited` 边读边计数，chunked 也拦）；
 * - 超过 `INGEST_SYNC_LIMIT`（500）才转异步批次 —— 1 万条必然是多个批次。
 *
 * 数据组成刻意贴近真实回填：24 小时历史、每 5 条里有 1 条是上游重报（同设备同类型 10 分钟内再来一次）、
 * 一部分用别名形如 `core-sw-01.lab`、一部分故意写不存在的主机名。这样"去重率"和"设备不存在占比"
 * 才有分母，不是 0/0。
 *
 * 用法（强烈建议对着一个**独立的临时库**跑，别污染演示库）：
 *   npm run loadtest:ingest -- --base=http://127.0.0.1:3200 --total=12000
 *   npm run loadtest:ingest -- --base=http://127.0.0.1:3200 --total=12000 --clean
 */

const BASE = (argValue('--base') ?? process.env.LOADTEST_BASE_URL ?? 'http://127.0.0.1:3000')
  .replace(/\/$/, '')
  .replace('localhost', '127.0.0.1');

const TOTAL = Number(argValue('--total') ?? 12_000);
/** 单请求行数：4000 × ~230B ≈ 0.9MB，稳在 2MB 限制内 */
const CHUNK = Math.min(5000, Number(argValue('--chunk') ?? 4000));
const HOURS = Number(argValue('--hours') ?? 24);
/** 不存在设备的占比（%）—— 接入期最容易被低估的成本 */
const MISS_PCT = Number(argValue('--miss') ?? 6);
/** 用别名上报的占比（%）—— 只对有别名登记的设备生效 */
const ALIAS_PCT = Number(argValue('--alias') ?? 20);
const SOURCE = argValue('--source') ?? 'loadtest';
/** 告警上没有 source 列，用 externalKey 前缀标记本次压测，清理与核对都靠它 */
const KEY_PREFIX = `${SOURCE}:`;
const KEY = argValue('--key') ?? process.env.API_KEY;
const CLEAN = process.argv.includes('--clean');
const POLL_MS = 500;
const POLL_TIMEOUT_MS = 15 * 60_000;

function argValue(name: string): string | undefined {
  const hit = process.argv.find((arg) => arg.startsWith(`${name}=`));
  return hit?.slice(name.length + 1);
}

/** 固定种子的 LCG：同一 `--total` 两次跑出来的构成一致，数字才可比 */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

/** 类型分布：可抑制类占多数（真实网络里端口/光功率告警就是大多数），父告警少量 */
const TYPE_PLAN: { type: string; metric?: string; severity: 'P0' | 'P1' | 'P2' | 'P3' }[] = [
  { type: 'LINK_DOWN', metric: 'if.oper.status', severity: 'P1' },
  { type: 'PORT_DOWN', metric: 'if.oper.status', severity: 'P2' },
  { type: 'OPTICAL_RX_LOW', metric: 'optic.rx', severity: 'P2' },
  { type: 'CRC_ERROR', metric: 'if.in.errors', severity: 'P2' },
  { type: 'BGP_NEIGHBOR_DOWN', metric: 'bgp.peer.state', severity: 'P1' },
  { type: 'CPU_HIGH', metric: 'cpu.util', severity: 'P2' },
  { type: 'PACKET_LOSS', metric: 'probe.loss', severity: 'P3' },
  { type: 'DEVICE_UNREACHABLE', severity: 'P0' },
  { type: 'LINECARD_FAILURE', severity: 'P0' },
];

type DeviceRow = { name: string; alias: string | null };

type GeneratedAlert = {
  /** 压测标记：`lt:<序号>`。Alert 表没有 source 列，靠它做清理与核对 */
  externalKey: string;
  deviceName: string;
  type: string;
  severity: string;
  metric?: string;
  value?: number;
  threshold?: number;
  message: string;
  firstSeen: string;
  lastSeen: string;
  category: 'name' | 'alias' | 'miss';
};

type BatchView = {
  id: string;
  status: string;
  total: number;
  processed: number;
  accepted: number;
  deduped: number;
  suppressed: number;
  failed: number;
  durationMs: number | null;
  error: string | null;
};

async function req(
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; json: unknown }> {
  const headers: Record<string, string> = { ...((init.headers as Record<string, string>) ?? {}) };
  if (KEY) headers['x-api-key'] = KEY;
  if (init.body) headers['content-type'] = 'application/json';
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers,
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  try {
    return { status: res.status, json: JSON.parse(text) as unknown };
  } catch {
    return { status: res.status, json: { raw: text.slice(0, 300) } };
  }
}

function pct(part: number, whole: number): string {
  return whole === 0 ? '—' : `${((part / whole) * 100).toFixed(1)}%`;
}

function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * values.length) - 1));
  return sorted[index] ?? null;
}

/* ------------------------------------------------------------------ 数据生成 */

async function loadDevices(): Promise<DeviceRow[]> {
  const rows = await db.device.findMany({
    orderBy: { name: 'asc' },
    select: { name: true, aliases: { select: { alias: true }, take: 1 } },
  });
  return rows.map((row) => ({ name: row.name, alias: row.aliases[0]?.alias ?? null }));
}

function generate(devices: readonly DeviceRow[], total: number): GeneratedAlert[] {
  if (devices.length === 0) throw new Error('设备表是空的：先跑 npm run db:seed');
  const random = makeRandom(20261121);
  const spanMs = HOURS * 3600_000;
  const startedAt = Date.now() - spanMs;
  const now = Date.now();
  const alerts: GeneratedAlert[] = [];

  for (let i = 0; i < total; i++) {
    // 设备按 1 步进、类型按"每轮设备数"步进：两者周期互质，组合周期 = 设备数 × 类型数。
    // 若两边都用 i%n 取模，周期会退化成 lcm(30,9)=90 —— 同一组合 10.8 分钟就重复一次，
    // 全部落进 30 分钟窗口被累加，"去重率"会虚高成 90%+（第一版就踩了这个坑）。
    const plan = TYPE_PLAN[Math.floor(i / devices.length) % TYPE_PLAN.length]!;
    const device = devices[i % devices.length]!;
    const roll = random() * 100;

    let deviceName = device.name;
    let category: GeneratedAlert['category'] = 'name';
    if (roll < MISS_PCT) {
      deviceName = `UNKNOWN-HOST-${i % 97}`;
      category = 'miss';
    } else if (roll < MISS_PCT + ALIAS_PCT && device.alias) {
      deviceName = device.alias;
      category = 'alias';
    } else {
      // 一半原样、一半小写：真实采集器的 host 大小写从不统一
      deviceName = i % 2 === 0 ? device.name : device.name.toLowerCase();
    }

    const at = Math.min(startedAt + (spanMs * i) / total, now);
    const alert: GeneratedAlert = {
      externalKey: `${KEY_PREFIX}${i}`,
      deviceName,
      type: plan.type,
      severity: plan.severity,
      ...(plan.metric
        ? { metric: plan.metric, value: Math.round(random() * 10000) / 100, threshold: 80 }
        : {}),
      message: `${plan.type} on ${deviceName}`,
      firstSeen: new Date(at).toISOString(),
      lastSeen: new Date(Math.min(at + 30_000, now)).toISOString(),
      category,
    };

    // 每 5 条里有 1 条是上游重报：完全复用 5 条前那条的 (设备, 类型, 指标, externalKey)，时间只往后挪 10 分钟。
    // 复用 externalKey 是有意的 —— 真实源（Zabbix eventid / Alertmanager fingerprint）都带上游 ID，
    // 幂等也走这条路；不带的源会落到"同指纹 + 30 分钟周期"的累加路径上。
    if (i >= 5 && i % 5 === 4) {
      const base = alerts[i - 5]!;
      const repostAt = Math.min(new Date(base.firstSeen).getTime() + 10 * 60_000, now);
      alerts.push({
        ...base,
        firstSeen: new Date(repostAt).toISOString(),
        lastSeen: new Date(Math.min(repostAt + 30_000, now)).toISOString(),
      });
      continue;
    }

    alerts.push(alert);
  }
  return alerts;
}

/* ------------------------------------------------------------------ 灌数据 */

type BatchResult = {
  batchId: string;
  rows: number;
  postMs: number;
  httpStatus: number;
  batch: BatchView | null;
};

async function dispatchChunk(rows: readonly GeneratedAlert[]): Promise<BatchResult> {
  const body = {
    source: SOURCE,
    // category 只是本地统计用的，不往上送（送进去会被 RawAlert 的 strict 校验挡住）
    alerts: rows.map((alert) => ({
      externalKey: alert.externalKey,
      deviceName: alert.deviceName,
      type: alert.type,
      severity: alert.severity,
      ...(alert.metric
        ? { metric: alert.metric, value: alert.value, threshold: alert.threshold }
        : {}),
      message: alert.message,
      firstSeen: alert.firstSeen,
      lastSeen: alert.lastSeen,
    })),
  };
  const startedAt = Date.now();
  const res = await req('/api/v1/ingest/alerts', { method: 'POST', body: JSON.stringify(body) });
  const postMs = Date.now() - startedAt;
  const json = res.json as { mode?: string; batchId?: string; error?: { message?: string } };

  if (res.status !== 202 && res.status !== 200) {
    throw new Error(`导入失败 HTTP ${res.status}：${json.error?.message ?? JSON.stringify(json)}`);
  }
  if (json.mode !== 'async' || !json.batchId) {
    // 行数 ≤ INGEST_SYNC_LIMIT 时会同步返回，这时候没有批次号，直接按结果记账
    return { batchId: '-', rows: rows.length, postMs, httpStatus: res.status, batch: null };
  }
  return { batchId: json.batchId, rows: rows.length, postMs, httpStatus: res.status, batch: null };
}

async function waitBatch(batchId: string): Promise<BatchView> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  for (;;) {
    const res = await req(`/api/v1/ingest/batches/${batchId}`);
    const batch = res.json as BatchView;
    if (res.status !== 200) throw new Error(`查批次失败 HTTP ${res.status}`);
    if (batch.status === 'DONE' || batch.status === 'FAILED') return batch;
    if (Date.now() > deadline) throw new Error(`批次 ${batchId} 超时未完成（${batch.status}）`);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

/* ------------------------------------------------------------------ 清理 */

async function clean(): Promise<void> {
  const alerts = await db.alert.findMany({
    where: { externalKey: { startsWith: KEY_PREFIX } },
    select: { id: true, incidentId: true },
  });
  const ids = alerts.map((alert) => alert.id);
  const incidentIds = [
    ...new Set(alerts.map((alert) => alert.incidentId).filter((id): id is string => !!id)),
  ];

  if (ids.length > 0) {
    // 自关联外键：先解掉"被我压制的"引用，否则删除会被挡住
    await db.alert.updateMany({
      where: { suppressedByAlertId: { in: ids } },
      data: { suppressedByAlertId: null },
    });
    await db.alert.deleteMany({ where: { id: { in: ids } } });
  }

  let removedIncidents = 0;
  for (const id of incidentIds) {
    if ((await db.alert.count({ where: { incidentId: id } })) > 0) continue;
    try {
      await db.incident.delete({ where: { id } });
      removedIncidents++;
    } catch {
      // 挂着案例/假设的事件删不掉，留着比强删安全
    }
  }

  const batches = await db.ingestBatch.deleteMany({ where: { source: SOURCE } });
  // 指纹是派生的（sha1(设备|类型|指标)），下次导入会自己重建；不删的话设备详情里会留一堆空条目
  const fingerprints = await db.alertFingerprint.deleteMany({ where: { alerts: { none: {} } } });
  console.log(
    `\n【清理压测数据】告警 ${ids.length} · 事件 ${removedIncidents} · 批次 ${batches.count} · 空指纹 ${fingerprints.count}`,
  );
  console.log('  审计日志保留（追加型证据链）。');
}

/* ------------------------------------------------------------------ 主流程 */

async function main(): Promise<void> {
  if (CLEAN) {
    await clean();
    await db.$disconnect();
    return;
  }

  const devices = await loadDevices();
  const aliasCovered = devices.filter((device) => device.alias !== null).length;
  const alerts = generate(devices, TOTAL);
  const composition = {
    name: alerts.filter((a) => a.category === 'name').length,
    alias: alerts.filter((a) => a.category === 'alias').length,
    miss: alerts.filter((a) => a.category === 'miss').length,
  };
  const payloadBytes = Buffer.byteLength(
    JSON.stringify({ source: SOURCE, alerts: alerts.slice(0, CHUNK) }),
  );
  const combos = devices.length * TYPE_PLAN.length;
  const cyclesPerCombo = TOTAL / combos;
  const gapMin = (HOURS * 60) / cyclesPerCombo;
  const reposts = alerts.filter((alert, index) => {
    const previous = alerts[index - 5];
    return previous !== undefined && previous.externalKey === alert.externalKey;
  }).length;

  console.log(`\nNetScope 回填压测 · 目标 ${BASE}`);
  console.log(
    `数据 ${TOTAL} 条 / ${HOURS}h 历史 · 设备 ${devices.length} 台（有别名 ${aliasCovered} 台）`,
  );
  console.log(
    `构成：设备名 ${composition.name} · 别名 ${composition.alias} · 不存在主机 ${composition.miss}（${pct(composition.miss, TOTAL)}）· 上游重报 ${reposts}（${pct(reposts, TOTAL)}）`,
  );
  console.log(
    `组合 ${combos} 种（设备×类型）· 每组合约 ${cyclesPerCombo.toFixed(0)} 个周期 · 同组合间隔 ${gapMin.toFixed(1)} 分钟`,
  );
  if (gapMin < 30) {
    console.log(
      '  ⚠ 同组合间隔 < 30 分钟：会有大量告警被判为"同一周期累加"，去重率不代表上游重报率',
    );
  }
  console.log(
    `分 ${Math.ceil(TOTAL / CHUNK)} 批，每批 ${CHUNK} 行（约 ${(payloadBytes / 1024).toFixed(0)} KB，限制 2 MB）\n`,
  );

  const results: BatchResult[] = [];
  const wallStart = Date.now();

  for (let offset = 0; offset < alerts.length; offset += CHUNK) {
    const chunk = alerts.slice(offset, offset + CHUNK);
    const result = await dispatchChunk(chunk);
    // 顺序灌：并发灌会让吞吐数字混在一起，看不出单批耗时
    if (result.batchId !== '-') result.batch = await waitBatch(result.batchId);
    results.push(result);

    const done = result.batch;
    console.log(
      `  批次 ${results.length}/${Math.ceil(TOTAL / CHUNK)}：${result.rows} 行 · 202 用时 ${result.postMs}ms · ` +
        (done
          ? `${done.status} ${done.processed}/${done.total} · 入库 ${done.accepted} · 去重 ${done.deduped} · 失败 ${done.failed} · 耗时 ${done.durationMs}ms`
          : '同步返回'),
    );
  }

  const wallMs = Date.now() - wallStart;
  const totals = results.reduce(
    (acc, item) => {
      const batch = item.batch;
      acc.rows += item.rows;
      acc.accepted += batch?.accepted ?? 0;
      acc.deduped += batch?.deduped ?? 0;
      acc.suppressed += batch?.suppressed ?? 0;
      acc.failed += batch?.failed ?? 0;
      if (batch?.durationMs) acc.durations.push(batch.durationMs);
      if (batch?.status === 'FAILED') acc.failedBatches++;
      return acc;
    },
    {
      rows: 0,
      accepted: 0,
      deduped: 0,
      suppressed: 0,
      failed: 0,
      failedBatches: 0,
      durations: [] as number[],
    },
  );

  const postP50 = percentile(
    results.map((item) => item.postMs),
    50,
  );
  const postP90 = percentile(
    results.map((item) => item.postMs),
    90,
  );
  const throughput = wallMs === 0 ? 0 : Math.round((totals.rows / wallMs) * 1000);

  console.log('\n【结果】');
  console.log(
    `  总量        ${totals.rows} 行 · 墙钟 ${(wallMs / 1000).toFixed(1)}s · 吞吐 ${throughput} 行/秒`,
  );
  console.log(
    `  批次耗时    p50 ${percentile(totals.durations, 50)}ms · p90 ${percentile(totals.durations, 90)}ms · 失败批次 ${totals.failedBatches}`,
  );
  console.log(`  202 响应    p50 ${postP50}ms · p90 ${postP90}ms（异步受理，不受批处理耗时影响）`);
  console.log(
    `  入库        ${totals.accepted}（${pct(totals.accepted, totals.rows)}）· 抑制 ${totals.suppressed}`,
  );
  console.log(
    `  去重        ${totals.deduped}（${pct(totals.deduped, totals.rows)}）— 上游重报被合掉`,
  );
  console.log(
    `  设备不存在  ${totals.failed}（${pct(totals.failed, totals.rows)}）— 每条都要补一条别名或改采集配置`,
  );

  // 归因校验：若别名与大小写解析都对，失败数应≈故意写错的主机数
  const expectedMiss = composition.miss;
  const missGap = totals.failed - expectedMiss;
  console.log(
    `  归因        故意不存在 ${expectedMiss} vs 实际失败 ${totals.failed}（差 ${missGap}）` +
      (Math.abs(missGap) <= Math.max(5, expectedMiss * 0.05)
        ? ' → 别名与大小写解析正常'
        : ' → 有本应命中的设备没对上，查别名表'),
  );

  const created = await db.alert.count({ where: { externalKey: { startsWith: KEY_PREFIX } } });
  const incidents = await db.incident.count({ where: { startedAt: { gte: new Date(wallStart) } } });
  console.log(`  库内核对    本次来源告警 ${created} 条 · 新建事件 ${incidents} 个`);

  console.log('\n【Markdown（可直接贴文档）】');
  console.log('| 指标 | 数值 |');
  console.log('| --- | --- |');
  console.log(`| 回填量 | ${totals.rows} 条 / ${Math.ceil(TOTAL / CHUNK)} 批 |`);
  console.log(`| 墙钟 / 吞吐 | ${(wallMs / 1000).toFixed(1)}s · ${throughput} 行/秒 |`);
  console.log(
    `| 批次耗时 p50 / p90 | ${percentile(totals.durations, 50)}ms / ${percentile(totals.durations, 90)}ms |`,
  );
  console.log(`| 202 受理 p50 / p90 | ${postP50}ms / ${postP90}ms |`);
  console.log(`| 入库 / 去重 / 失败 | ${totals.accepted} / ${totals.deduped} / ${totals.failed} |`);
  console.log(
    `| 去重率 / 设备不存在率 | ${pct(totals.deduped, totals.rows)} / ${pct(totals.failed, totals.rows)} |`,
  );

  console.log('\n清理：npm run loadtest:ingest -- --clean（按 source=' + SOURCE + ' 删）');
  await db.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await db.$disconnect().catch(() => {});
  process.exit(1);
});
