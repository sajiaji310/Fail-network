import { loadEnvFile } from 'node:process';
import { db } from '../src/lib/db';
import { findDevice, loadDevices } from '../src/modules/ingest/resolve';
import { stripPort } from '../src/modules/ingest/sources/classify';
import { defaultWindow, getOpsMetrics } from '../src/modules/ops/metrics';

try {
  loadEnvFile('.env');
} catch {
  // 容器内用环境变量注入时没有 .env，忽略
}

/**
 * 第 4 阶段验收跑批（评审 299–308 行的五项能力）。
 *
 * 为什么要有这个脚本：`docs/STATE.md` 里的验收清单是 6 条 curl，手敲容易漏、
 * 敲错了还得人肉比对返回值。这里把「该验什么、期望什么、实际是什么」写成断言，
 * 一条命令跑完给结论，人工只负责最后那两件机器验不了的事
 * （真实环境回填、指标是否可信 —— 见结尾的「人工确认项」）。
 *
 * 两种模式：
 *   npm run accept:phase4            # 只读：健康检查 / 页面 / 批次 / 趋势 / 保留 dry-run / 别名解析
 *   npm run accept:phase4 -- --write # 追加写入：Alertmanager + Zabbix + 指标采样，再验一遍链路
 *   npm run accept:phase4 -- --clean # 清掉之前写入的验收数据（不动审计，审计是追加型的）
 *
 * 默认只读是因为这个脚本会被人对着生产实例跑一次 —— 默认写数据进生产库不合适。
 *
 * 写入的数据都带 `acceptance` 标记（指纹前缀 `acc-`、采样 source=acceptance、
 * 指标名 `acceptance.probe`），可以随时 `--clean` 清掉。
 */

const BASE = (argValue('--base') ?? process.env.ACCEPT_BASE_URL ?? 'http://127.0.0.1:3000')
  .replace(/\/$/, '')
  .replace('localhost', '127.0.0.1');
const KEY =
  argValue('--key') ?? firstKey(process.env.API_KEY ?? '') ?? firstKey(firstKeyFromApiKeys());
const WRITE = process.argv.includes('--write');
const CLEAN = process.argv.includes('--clean');

function argValue(name: string): string | undefined {
  const hit = process.argv.find((arg) => arg.startsWith(`${name}=`));
  return hit?.slice(name.length + 1);
}

/** API_KEYS 是 JSON 数组，取第一个 key 跑验收（APP_ENV=production 时才需要） */
function firstKeyFromApiKeys(): string {
  try {
    const raw = process.env.API_KEYS;
    if (!raw) return '';
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return '';
    const first = parsed.find((item) => typeof item === 'object' && item !== null) as
      { key?: unknown } | undefined;
    return typeof first?.key === 'string' ? first.key : '';
  } catch {
    return '';
  }
}

function firstKey(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/* ------------------------------------------------------------------ 断言骨架 */

type Status = 'PASS' | 'FAIL' | 'SKIP';
type Result = { group: string; name: string; status: Status; detail: string };

const results: Result[] = [];
let group = '服务';

function startGroup(name: string): void {
  group = name;
}

async function check(
  name: string,
  fn: () => Promise<{ ok: boolean; detail: string } | 'SKIP'>,
): Promise<void> {
  try {
    const out = await fn();
    if (out === 'SKIP') {
      results.push({ group, name, status: 'SKIP', detail: '未启用（加 --write）' });
      return;
    }
    results.push({ group, name, status: out.ok ? 'PASS' : 'FAIL', detail: out.detail });
  } catch (error) {
    results.push({
      group,
      name,
      status: 'FAIL',
      detail: `异常：${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

/* ------------------------------------------------------------------ HTTP */

type Res = { status: number; json: Record<string, unknown> | null; text: string };

async function req(path: string, init: RequestInit = {}): Promise<Res> {
  const headers: Record<string, string> = { ...((init.headers as Record<string, string>) ?? {}) };
  if (KEY) headers['x-api-key'] = KEY;
  if (init.body) headers['content-type'] = 'application/json';

  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers,
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
}

const post = (path: string, body: unknown): Promise<Res> =>
  req(path, { method: 'POST', body: JSON.stringify(body) });

function errText(res: Res): string {
  const error = res.json?.['error'] as { code?: string; message?: string } | undefined;
  return error ? `${error.code ?? 'ERROR'} ${error.message ?? ''}`.trim() : `HTTP ${res.status}`;
}

const num = (value: unknown): number => (typeof value === 'number' ? value : Number(value ?? 0));
const str = (value: unknown): string => (typeof value === 'string' ? value : '');

/** issues 里解析期是字符串、导入期是 {deviceName, message}，两种都要能读出人话 */
function issueText(item: unknown): string {
  if (typeof item === 'string') return item;
  if (item !== null && typeof item === 'object') {
    const record = item as Record<string, unknown>;
    return `${str(record['message'])} ${str(record['deviceName'])}`;
  }
  return '';
}

function sec(seconds: number | null): string {
  if (seconds === null) return '—';
  if (seconds < 90) return `${Math.round(seconds)} 秒`;
  if (seconds < 5400) return `${(seconds / 60).toFixed(1)} 分钟`;
  return `${(seconds / 3600).toFixed(1)} 小时`;
}

function ratio(rate: number | null): string {
  return rate === null ? '—（分母为 0）' : `${(rate * 100).toFixed(1)}%`;
}

/* ------------------------------------------------------------------ 一、服务与页面 */

async function checkService(): Promise<void> {
  startGroup('服务');

  await check('健康检查 /api/health', async () => {
    const res = await req('/api/health');
    const status = str(res.json?.['status']);
    const dbState = str(res.json?.['db']);
    // 健康检查按 P0-2 脱敏，只回 status/db/llm，阶段文案在页面里（见下一条）
    return {
      ok: res.status === 200 && status === 'ok' && dbState === 'up',
      detail: `status=${status} db=${dbState}`,
    };
  });

  await check('页头阶段徽标（控制台布局）', async () => {
    // 阶段文案在 Topbar，服务端渲染进每个控制台页面；取 /overview 只是随便挑一页
    const res = await req('/overview');
    const hit = res.text.includes('第 4 阶段');
    return { ok: res.status === 200 && hit, detail: `HTTP ${res.status} 含「第 4 阶段」=${hit}` };
  });

  await check('数据源页 /sources', async () => {
    const res = await req('/sources');
    const hit = res.text.includes('推送地址');
    return { ok: res.status === 200 && hit, detail: `HTTP ${res.status} 含「推送地址」=${hit}` };
  });

  await check('运行指标页 /metrics', async () => {
    const res = await req('/metrics');
    const hit = res.text.includes('MTTR');
    return { ok: res.status === 200 && hit, detail: `HTTP ${res.status} 含「MTTR」=${hit}` };
  });

  await check('交付进度 /settings（T01–T16）', async () => {
    const res = await req('/settings');
    // 卡片标题的 hint 渲染为「16/16 已完成」，少一条就说明卡片表与 STATE 脱节
    const hit = res.text.includes('16/16');
    return { ok: res.status === 200 && hit, detail: `HTTP ${res.status} 含「16/16」=${hit}` };
  });

  await check('批次列表 /api/v1/ingest/batches', async () => {
    const res = await req('/api/v1/ingest/batches?limit=5');
    const items = res.json?.['items'];
    return {
      ok: res.status === 200 && Array.isArray(items),
      detail:
        res.status === 200
          ? `HTTP 200，最近 ${Array.isArray(items) ? items.length : 0} 批，进行中 ${num(res.json?.['running'])}`
          : errText(res),
    };
  });

  await check('保留策略 dry-run /api/v1/admin/retention', async () => {
    const res = await post('/api/v1/admin/retention', { dryRun: true });
    const dryRun = res.json?.['dryRun'];
    const deleted = res.json?.['deleted'];
    return {
      ok: res.status === 200 && dryRun === true && typeof deleted === 'object',
      detail:
        res.status === 200
          ? `dryRun=${String(dryRun)} 可清理=${JSON.stringify(deleted)}`
          : errText(res),
    };
  });
}

/* ------------------------------------------------------------------ 二、真实源接入（--write） */

const stamp = Date.now().toString(36);
const PROBE_METRIC = 'acceptance.probe';

async function checkIngest(): Promise<void> {
  startGroup('真实源接入');

  if (!WRITE) {
    await check('Alertmanager webhook', async () => 'SKIP');
    await check('Zabbix webhook（设备不存在提示）', async () => 'SKIP');
    await check('指标采样写入 + 幂等', async () => 'SKIP');
    await check('批次进度落库', async () => 'SKIP');
    return;
  }

  const now = Date.now();
  const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString();

  await check('Alertmanager webhook（resolved 跳过 / 别名命中）', async () => {
    const res = await post('/api/v1/ingest/alertmanager?source=acceptance', {
      version: '4',
      status: 'firing',
      alerts: [
        {
          status: 'firing',
          labels: {
            alertname: 'InterfaceDown',
            instance: 'core-sw-01.lab:9100',
            severity: 'critical',
          },
          annotations: { summary: 'Gi1/0/1 link down（验收）' },
          startsAt: iso(-60_000),
          fingerprint: `acc-${stamp}-1`,
        },
        {
          status: 'resolved',
          labels: {
            alertname: 'InterfaceDown',
            instance: 'core-sw-01.lab:9100',
            severity: 'critical',
          },
          startsAt: iso(-600_000),
          endsAt: iso(-120_000),
          fingerprint: `acc-${stamp}-2`,
        },
      ],
    });
    if (res.status !== 200 && res.status !== 202) {
      return { ok: false, detail: errText(res) };
    }
    const mode = str(res.json?.['mode']);
    const skipped = num(res.json?.['skipped']);
    const failed = num(res.json?.['failed']);
    return {
      ok: (mode === 'sync' || mode === 'async') && skipped === 1 && failed === 0,
      detail: `mode=${mode} 跳过已恢复=${skipped} 失败=${failed} 入库=${num(res.json?.['accepted'])}`,
    };
  });

  await check('Zabbix webhook（设备不存在要说清楚）', async () => {
    const res = await post('/api/v1/ingest/zabbix?source=acceptance', {
      host: 'NO-SUCH-HOST-ACC',
      trigger: 'Interface Gi0/2 link down',
      severity: 4,
      eventid: `acc-${stamp}`,
      clock: Math.floor(now / 1000) - 30,
    });
    if (res.status !== 200 && res.status !== 202) return { ok: false, detail: errText(res) };
    const issues = Array.isArray(res.json?.['issues']) ? (res.json?.['issues'] as unknown[]) : [];
    const hinted = issues.some((item) => issueText(item).includes('设备不存在'));
    return {
      ok: hinted && num(res.json?.['failed']) >= 1,
      detail: `失败=${num(res.json?.['failed'])} 提示=${hinted ? '含「设备不存在」' : issues.slice(0, 2).map(issueText).join(' | ') || '无'}`,
    };
  });

  const samples = [
    { deviceName: 'CORE-SW-01', metric: PROBE_METRIC, value: 71.5, unit: 'ms', at: iso(-360_000) },
    { deviceName: 'CORE-SW-01', metric: PROBE_METRIC, value: 88.2, unit: 'ms', at: iso(-60_000) },
  ].map((row) => ({ ...row, source: 'acceptance' }));

  await check('指标采样写入（2 条）', async () => {
    const res = await post('/api/v1/metrics/samples', { samples });
    return {
      ok: res.status === 200 && num(res.json?.['accepted']) === 2,
      detail: res.status === 200 ? `入库=${num(res.json?.['accepted'])}` : errText(res),
    };
  });

  await check('重推同一批采样（幂等：不新增点）', async () => {
    const res = await post('/api/v1/metrics/samples', { samples });
    return {
      ok:
        res.status === 200 && num(res.json?.['accepted']) === 0 && num(res.json?.['skipped']) === 2,
      detail:
        res.status === 200
          ? `新入库=${num(res.json?.['accepted'])} 去重=${num(res.json?.['skipped'])}`
          : errText(res),
    };
  });

  await check('指标趋势（首末 / 峰谷 / 斜率）', async () => {
    const res = await req(
      `/api/v1/metrics?deviceName=CORE-SW-01&metric=${PROBE_METRIC}&minutes=60`,
    );
    const trend = res.json?.['trend'] as
      | { samples: number; first: number; last: number; max: number; slopePerMin: number }
      | null
      | undefined;
    if (!trend) return { ok: false, detail: `没有趋势：${errText(res)}` };
    return {
      ok: trend.samples >= 2 && trend.last === 88.2 && trend.max >= 88.2 && trend.first === 71.5,
      detail: `${trend.samples} 点，首 ${trend.first} → 末 ${trend.last}，峰 ${trend.max}，斜率 ${trend.slopePerMin}/分钟`,
    };
  });

  await check('批次进度落库（DONE + 100%）', async () => {
    const res = await req('/api/v1/ingest/batches?limit=5');
    const items = (res.json?.['items'] as Record<string, unknown>[] | undefined) ?? [];
    const mine = items.find((item) => str(item['source']) === 'acceptance');
    if (!mine) return { ok: false, detail: '最近 5 批里没找到 source=acceptance 的批次' };
    return {
      ok: str(mine['status']) === 'DONE' && num(mine['progress']) === 100,
      detail: `${str(mine['kind'])} ${str(mine['status'])} ${num(mine['processed'])}/${num(mine['total'])} 耗时 ${num(mine['durationMs'])}ms`,
    };
  });
}

/* ------------------------------------------------------------------ 三、库侧口径 */

async function checkDatabase(): Promise<void> {
  startGroup('库侧口径');

  await check('设备别名解析（别名优先于设备名）', async () => {
    const lookup = await loadDevices('default');
    // 分工：适配器负责剥掉 instance 的端口，resolve 负责 别名→名→IP 匹配
    const instance = stripPort('core-sw-01.lab:9100');
    const byAlias = findDevice(lookup, instance);
    const byIp = findDevice(lookup, '10.0.0.1');
    const byName = findDevice(lookup, 'core-sw-01');
    return {
      ok:
        byAlias?.name === 'CORE-SW-01' &&
        byIp?.name === 'CORE-SW-01' &&
        byName?.name === 'CORE-SW-01',
      detail: `instance=${instance} 别名=${byAlias?.name ?? '未命中'} IP=${byIp?.name ?? '未命中'} 名字(小写)=${byName?.name ?? '未命中'}`,
    };
  });

  await check('指标采样可查回（库侧直读）', async () => {
    if (!WRITE) return 'SKIP';
    const rows = await db.metricSample.findMany({
      where: { metric: PROBE_METRIC },
      orderBy: { at: 'asc' },
      select: { value: true, source: true },
    });
    return {
      ok: rows.length >= 2,
      detail:
        rows.length === 0
          ? '无 acceptance.probe 采样'
          : `${rows.length} 点，来源=${[...new Set(rows.map((r) => r.source))].join('/')}`,
    };
  });
}

/* ------------------------------------------------------------------ 清理 */

/**
 * 清掉验收写入的数据（`--clean`）。
 *
 * 顺序不能换：先解掉抑制自引用（外键会挡住删除），再删告警，然后只删
 * 「被这次验收创建、且已经不挂任何告警」的事件壳 —— 带真实告警的事件一律不碰。
 * 审计日志不删：它是追加型的证据链，删了等于改历史，留痕反而说明验收跑过。
 */
async function cleanAcceptance(): Promise<void> {
  const alerts = await db.alert.findMany({
    where: {
      OR: [{ externalKey: { startsWith: 'am:acc-' } }, { externalKey: { startsWith: 'zbx:acc-' } }],
    },
    select: { id: true, incidentId: true },
  });
  const alertIds = alerts.map((alert) => alert.id);
  const incidentIds = [
    ...new Set(alerts.map((alert) => alert.incidentId).filter((id): id is string => !!id)),
  ];

  if (alertIds.length > 0) {
    await db.alert.updateMany({
      where: { suppressedByAlertId: { in: alertIds } },
      data: { suppressedByAlertId: null },
    });
    await db.alert.deleteMany({ where: { id: { in: alertIds } } });
  }

  let removedIncidents = 0;
  for (const id of incidentIds) {
    const left = await db.alert.count({ where: { incidentId: id } });
    if (left > 0) continue;
    try {
      await db.incident.delete({ where: { id } });
      removedIncidents++;
    } catch {
      // 挂着案例/假设子表时删不掉：留着比强删安全
    }
  }

  const batches = await db.ingestBatch.deleteMany({ where: { source: 'acceptance' } });
  const samples = await db.metricSample.deleteMany({
    where: { OR: [{ metric: PROBE_METRIC }, { source: 'acceptance' }] },
  });

  console.log(
    `\n【清理验收数据】告警 ${alertIds.length} · 事件 ${removedIncidents} · 批次 ${batches.count} · 采样 ${samples.count}`,
  );
  console.log('  审计日志保留（追加型证据链，不在这里删）。');
}

/* ------------------------------------------------------------------ 主流程 */

async function main(): Promise<void> {
  if (CLEAN) {
    await cleanAcceptance();
    await db.$disconnect();
    return;
  }

  console.log(`\nNetScope 第 4 阶段验收 · 目标 ${BASE} · 模式 ${WRITE ? '只读+写入' : '只读'}`);
  console.log(
    `鉴权 ${KEY ? `x-api-key: ${KEY.slice(0, 3)}***` : '未带 Key（APP_ENV=local 时正常）'}\n`,
  );

  await checkService();
  await checkIngest();
  await checkDatabase();

  // 分组打印
  let current = '';
  for (const item of results) {
    if (item.group !== current) {
      current = item.group;
      console.log(`\n【${current}】`);
    }
    const tag = item.status === 'PASS' ? 'PASS' : item.status === 'FAIL' ? 'FAIL' : 'SKIP';
    console.log(`  [${tag}] ${item.name}`);
    if (item.detail) console.log(`         ${item.detail}`);
  }

  // 运行指标：不是断言，是"能量出来"
  const window = defaultWindow(30);
  const metrics = await getOpsMetrics(window);
  console.log(`\n【运行指标 · 最近 ${window.days} 天】`);
  console.log(
    `  MTTR      p50 ${sec(metrics.incidents.mttrSeconds.p50)} · p90 ${sec(metrics.incidents.mttrSeconds.p90)} · 均值 ${sec(metrics.incidents.mttrSeconds.avg)}（${metrics.incidents.mttrSeconds.samples} 个已结案样本）`,
  );
  console.log(
    `  人工接受率 ${ratio(metrics.acceptance.rate)}（已裁决 ${metrics.acceptance.decided} 条：采纳 ${metrics.acceptance.accepted} / 驳回 ${metrics.acceptance.rejected}）`,
  );
  console.log(
    `  误抑制率   ${ratio(metrics.suppression.rate)}（被压 ${metrics.suppression.suppressed} 条，其中压错 ${metrics.suppression.wrong} 条，波及 ${metrics.suppression.affectedIncidents} 个事件）`,
  );
  console.log(
    `  数据接入   批次 ${metrics.dataSources.batches} · 真实源告警 ${metrics.dataSources.realAlerts} · 模拟告警 ${metrics.dataSources.simulatedAlerts} · 采样点 ${metrics.dataSources.metricSamples}`,
  );
  if (metrics.dataSources.byKind.length > 0) {
    console.log(
      `  按来源     ${metrics.dataSources.byKind
        .map((row) => `${row.kind}:${row.batches}批/入库${row.accepted}/失败${row.failed}`)
        .join(' · ')}`,
    );
  }
  console.log('  口径：MTTR 取已结案事件的 p50/p90；接受率分母只算"人真的点过按钮"的假设；');
  console.log(
    '        误抑制=父告警已恢复而自身仍 SUPPRESSED。详见 src/modules/ops/metrics.ts 注释。',
  );

  const failed = results.filter((item) => item.status === 'FAIL').length;
  const passed = results.filter((item) => item.status === 'PASS').length;
  const skipped = results.filter((item) => item.status === 'SKIP').length;

  console.log(`\n结论：PASS ${passed} / FAIL ${failed} / SKIP ${skipped}`);
  if (failed > 0) {
    console.log('有失败项，先按上面的实际值排查；页面类失败常见于服务没起或构建产物过期。');
  }

  console.log('\n【人工确认项 · 脚本验不了】');
  console.log('  1. 用真实环境的一批 ≥1 万条告警回填，看批次耗时、去重率与「设备不存在」占比');
  console.log('  2. 真实事件上的人工接受率是否可信（规则降级下的接受率不代表 LLM 质量）');
  console.log('  3. 误抑制是否为「压太久」而非「压错对象」—— 当前口径只覆盖后者');

  if (WRITE) {
    console.log('\n【清理验收数据】npm run accept:phase4 -- --clean');
    console.log(
      `  标记：告警指纹 acc- 前缀 · 采样 source=acceptance / metric=${PROBE_METRIC} · 批次 source=acceptance`,
    );
    console.log('  或整体复原演示数据：npm run sim -- --scenario=core-uplink --reset');
  } else {
    console.log('\n只读模式未写入任何数据。要跑完整链路：npm run accept:phase4 -- --write');
  }
  console.log('');

  await db.$disconnect();
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
