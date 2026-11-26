/**
 * 评测执行器（文档 10.5）：
 *
 *   npm run eval -- --set=dev             # 调参用，可反复跑
 *   npm run eval -- --set=test            # 里程碑验收，只跑一次并记录
 *   npm run eval -- --set=test --mode=mock # 走 LLM 链路（fixture），演示 L1 拦截
 *   npm run eval -- --set=dev --only=dev-03,dev-05 --verbose
 *
 * 每个场景独立：清场 → 注入 → 聚合 → 逐事件研判 → 打分 → 清场。
 * 场景之间不共享数据，所以顺序不影响结果。
 *
 * LLM_MOCK 必须在 `lib/env` 首次求值前写入，故业务模块全部动态 import。
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadEnvFile } from 'node:process';
import type { LinkStatus } from '@prisma/client';
import { classifyAlertType } from '../src/modules/alerts/taxonomy';
import { attributionTag } from '../src/modules/rca/explainability';
import { assessTopology } from '../src/modules/topology/completeness';
import { aggregate, scoreCase, type Observation, type ObservedHypothesis } from './metrics';
import { renderMarkdown, type EvalReport } from './report';
import { EvalCaseSchema, type EvalCase } from './schema';

try {
  loadEnvFile('.env');
} catch {
  // CI / docker 由外部注入
}

const DATASET_DIR = path.join(process.cwd(), 'evals', 'dataset');
const RESULT_DIR = path.join(process.cwd(), 'evals', 'results');

/**
 * test 集冻结参数（Spec §4.1/§4.3）。
 *
 * 16 例 = 14 例有标注根因 + 2 例必须拒答。这两个分母写死在这里而不是从数据里推：
 * 有人偷偷删掉一个难例，总数就从 16 变 15、分母从 14 变 13，分数会"自动变好"。
 * 冻结的意义就是让这种改动必须显式改这个常量，从而在 review 里被看见。
 */
const TEST_TOTAL = 16;
const TEST_ANSWERABLE = 14;
const TEST_ABSTAIN = 2;

type Options = {
  set: 'dev' | 'test' | 'all';
  mode: 'fallback' | 'mock';
  only: string[];
  verbose: boolean;
  write: boolean;
};

function parseOptions(argv: readonly string[]): Options {
  const pick = (name: string): string | undefined =>
    argv
      .find((arg) => arg.startsWith(`--${name}=`))
      ?.split('=')
      .slice(1)
      .join('=');
  const set = pick('set') ?? 'dev';
  if (set !== 'dev' && set !== 'test' && set !== 'all') {
    throw new Error(`--set 只能是 dev / test / all，收到 ${set}`);
  }
  const mode = pick('mode') ?? 'fallback';
  if (mode !== 'fallback' && mode !== 'mock') {
    throw new Error(`--mode 只能是 fallback / mock，收到 ${mode}`);
  }
  return {
    set,
    mode,
    only: (pick('only') ?? '').split(',').filter(Boolean),
    verbose: argv.includes('--verbose'),
    write: !argv.includes('--no-write'),
  };
}

const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');

/**
 * 归一化后再算哈希：Windows 上 `core.autocrlf` 会在 checkout 时把 LF 换成 CRLF，
 * 直接对字节做摘要会让同一份数据在不同机器上算出不同哈希，冻结机制反而变成"环境检测器"。
 * 只抹平换行符，内容差异照旧能检出。
 */
const normalizedSha256 = (file: string): string =>
  sha256(readFileSync(file, 'utf8').replace(/\r\n/g, '\n'));

/**
 * test 集冻结校验（Spec §4.3）：
 *   1. 16 个 JSON 的哈希必须与 `MANIFEST.sha256` 逐行一致；
 *   2. 分母必须是 14 有标注 + 2 拒答。
 * 任一不符直接非 0 退出 —— 一份被改过的留出集跑出来的分数，比没有分数更危险。
 *
 * 只在**跑全集**时校验分母：`--only` 是调参用的过滤视图，它天然不是 14/2。
 */
function verifyTestSet(all: readonly EvalCase[], filtered: boolean): string {
  const dir = path.join(DATASET_DIR, 'test');
  const manifestPath = path.join(dir, 'MANIFEST.sha256');
  const manifest = readFileSync(manifestPath, 'utf8').replace(/\r\n/g, '\n');
  const expected = new Map<string, string>();
  for (const line of manifest.split('\n')) {
    const match = /^([0-9a-f]{64})\s+(\S+\.json)$/.exec(line.trim());
    if (!match) continue;
    expected.set(match[2]!, match[1]!);
  }

  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort();
  const problems: string[] = [];
  for (const file of files) {
    const actual = normalizedSha256(path.join(dir, file));
    const wanted = expected.get(file);
    if (!wanted) problems.push(`${file}: 清单里没有这一行`);
    else if (wanted !== actual)
      problems.push(`${file}: 哈希不符（清单 ${wanted.slice(0, 8)}，实际 ${actual.slice(0, 8)}）`);
  }
  for (const file of expected.keys()) {
    if (!files.includes(file)) problems.push(`${file}: 清单里有，磁盘上没有`);
  }

  const testCases = all.filter((c) => c.set === 'test');
  const answerable = testCases.filter((c) => c.expect.rootCause !== null).length;
  const abstain = testCases.length - answerable;
  if (!filtered) {
    if (testCases.length !== TEST_TOTAL) {
      problems.push(`test 集 ${testCases.length} 例，冻结值为 ${TEST_TOTAL}`);
    }
    if (answerable !== TEST_ANSWERABLE || abstain !== TEST_ABSTAIN) {
      problems.push(`分母 ${answerable}/${abstain}，冻结值为 ${TEST_ANSWERABLE}/${TEST_ABSTAIN}`);
    }
  }

  if (problems.length > 0) {
    throw new Error(`test 集冻结校验失败：\n  - ${problems.join('\n  - ')}`);
  }
  return sha256(manifest);
}

function loadCases(set: Options['set']): EvalCase[] {
  const sets = set === 'all' ? ['dev', 'test'] : [set];
  const cases: EvalCase[] = [];
  for (const name of sets) {
    const dir = path.join(DATASET_DIR, name);
    for (const file of readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort()) {
      const raw: unknown = JSON.parse(readFileSync(path.join(dir, file), 'utf8'));
      const parsed = EvalCaseSchema.safeParse(raw);
      if (!parsed.success) {
        throw new Error(
          `数据集 ${name}/${file} 不合法：${parsed.error.issues
            .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
            .join('; ')}`,
        );
      }
      if (parsed.data.set !== name) {
        throw new Error(`数据集 ${name}/${file} 的 set 字段是 ${parsed.data.set}，与目录不一致`);
      }
      cases.push(parsed.data);
    }
  }
  return cases;
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.mode === 'mock') process.env.LLM_MOCK = 'true';

  const { llmMode } = await import('@/lib/env');
  const { db } = await import('@/lib/db');
  const { resetDemoData } = await import('@/modules/ingest/reset');
  const { runScenarioSpec } = await import('@/modules/ingest/scenario');
  const { runScenarioInWaves } = await import('./waves');
  const { runAnalysis } = await import('@/modules/rca/analyze');

  const all = loadCases(options.set);
  // 冻结校验先于任何数据库操作：留出集被改过就别跑了，跑出来的数字不能用
  const manifestDigest = options.set === 'dev' ? null : verifyTestSet(all, options.only.length > 0);
  const cases = options.only.length === 0 ? all : all.filter((c) => options.only.includes(c.id));
  if (cases.length === 0) throw new Error('没有匹配的场景，检查 --set / --only');

  // CLI 的 fallback 只是「不强制 mock」。有 Key 时实际是 live。
  const reportedMode = options.mode === 'mock' ? 'mock' : llmMode();
  const startedAt = new Date();
  const scores = [];

  process.stdout.write(
    `[eval] ${cases.length} 个场景 · set=${options.set} · mode=${reportedMode}\n`,
  );

  for (const kase of cases) {
    await resetDemoData();

    // 缺拓扑类场景：先摘链路，跑完再按快照恢复（不改 seed 文件）
    const removed: {
      sourceId: string;
      targetId: string;
      bandwidth: number | null;
      status: LinkStatus;
    }[] = [];
    for (const pair of kase.mutations.removeLinks) {
      const [source, target] = pair.split('|');
      if (!source || !target) throw new Error(`${kase.id}: removeLinks 格式应为 "源|目标"`);
      const links = await db.topologyLink.findMany({
        where: { source: { name: source }, target: { name: target } },
      });
      removed.push(
        ...links.map((l) => ({
          sourceId: l.sourceId,
          targetId: l.targetId,
          bandwidth: l.bandwidth,
          status: l.status,
        })),
      );
      await db.topologyLink.deleteMany({
        where: { sourceId: { in: links.map((l) => l.sourceId) }, target: { name: target } },
      });
    }

    try {
      const sim =
        kase.waves.length > 0
          ? await runScenarioInWaves(kase.scenario, kase.waves, {
              seed: 42,
              now: new Date(),
              source: `eval:${kase.id}`,
            })
          : await runScenarioSpec(kase.scenario, {
              seed: 42,
              now: new Date(),
              source: `eval:${kase.id}`,
            });

      const incidents = await db.incident.findMany({
        where: { clusterKey: { not: null } },
        orderBy: { code: 'asc' },
        select: {
          id: true,
          code: true,
          alerts: {
            where: { status: { not: 'SUPPRESSED' } },
            select: {
              firstSeen: true,
              fingerprint: {
                select: { type: true, deviceId: true, device: { select: { name: true } } },
              },
            },
          },
        },
      });

      // 证据 ref → 设备名：一次把三张表读进来，避免每条证据一次查询
      const [alertRows, changeRows, linkRows, orphanAlerts] = await Promise.all([
        db.alert.findMany({
          select: { id: true, fingerprint: { select: { device: { select: { name: true } } } } },
        }),
        db.changeRecord.findMany({ select: { id: true, device: { select: { name: true } } } }),
        db.topologyLink.findMany({
          select: {
            id: true,
            sourceId: true,
            targetId: true,
            source: { select: { name: true } },
            target: { select: { name: true } },
          },
        }),
        // 孤岛告警：没有进任何事件、仍活跃 —— 用户只能逐条看的量
        db.alert.count({ where: { incidentId: null, status: 'ACTIVE' } }),
      ]);
      const deviceOfRef = new Map<string, string[]>();
      for (const row of alertRows) {
        deviceOfRef.set(row.id, [row.fingerprint.device.name]);
      }
      for (const row of changeRows) {
        deviceOfRef.set(row.id, [row.device.name]);
      }
      for (const row of linkRows) {
        deviceOfRef.set(row.id, [row.source.name, row.target.name]);
      }

      let rootAlertSuppressed: boolean | null = null;
      if (kase.expect.rootAlert) {
        const count = await db.alert.count({
          where: {
            status: 'SUPPRESSED',
            fingerprint: {
              type: kase.expect.rootAlert.type,
              device: { name: kase.expect.rootAlert.device },
            },
          },
        });
        rootAlertSuppressed = count > 0;
      }

      const analyses = [];
      const hintOnly: { category: string; device: string }[] = [];
      for (const incident of incidents) {
        // 朴素基线：最早告警的设备 + 该类型的归因标签。不调模型、不看拓扑，只用时间与字典
        const earliest = [...incident.alerts].sort(
          (a, b) => a.firstSeen.getTime() - b.firstSeen.getTime(),
        )[0];
        if (earliest) {
          hintOnly.push({
            category: attributionTag(
              earliest.fingerprint.type,
              classifyAlertType(earliest.fingerprint.type),
            ),
            device: earliest.fingerprint.device.name,
          });
        }

        const began = Date.now();
        const outcome = await runAnalysis(incident.id, { force: true });
        const durationMs = Date.now() - began;
        if (!outcome) throw new Error(`${kase.id}: 事件 ${incident.code} 研判返回 null`);

        const hypotheses: ObservedHypothesis[] = outcome.hypotheses.map((h, index) => ({
          category: h.category,
          cause: h.cause,
          confidence: h.confidence,
          deviceRefs: [...new Set(h.evidence.flatMap((e) => deviceOfRef.get(e.ref) ?? []))],
          // 逐条取来源：补位之后同一份结论里会混着两种来源，按事件取第一个分析会失真
          origin: outcome.hypothesesOrigin?.[index],
        }));

        analyses.push({
          code: incident.code,
          source: outcome.source,
          hypotheses,
          dropped: outcome.verify.dropped.length,
          rawEvidence: outcome.verify.stats.rawEvidence,
          validEvidence: outcome.verify.stats.validEvidence,
          durationMs,
          tokensUsed: outcome.tokensUsed,
          topologyLevel: outcome.topologyLevel,
          reasoningMs:
            outcome.progress?.stages.find((s) => s.stage === 'REASONING')?.durationMs ?? 0,
        });
      }

      // 场景级拓扑完整度：取事件内全部设备的并集（单个事件视角可能漏掉跨事件的缺失）
      const incidentDeviceIds = [
        ...new Set(incidents.flatMap((i) => i.alerts.map((a) => a.fingerprint.deviceId))),
      ];
      const deviceNames = new Map(
        incidents.flatMap((i) =>
          i.alerts.map((a) => [a.fingerprint.deviceId, a.fingerprint.device.name] as const),
        ),
      );
      const coverage =
        incidents.length === 0
          ? null
          : assessTopology(
              incidentDeviceIds.map((id) => ({ id, name: deviceNames.get(id) ?? id })),
              linkRows,
            );

      const observation: Observation = {
        alertTotal: sim.alertTotal,
        incidentDevices: incidents.map((i) => [
          ...new Set(i.alerts.map((a) => a.fingerprint.device.name)),
        ]),
        rootAlertSuppressed,
        orphanAlerts,
        topologyLevel: coverage?.level ?? null,
        analyses,
        hintOnly,
      };

      const score = scoreCase(kase, observation);
      scores.push(score);

      if (options.verbose) {
        process.stdout.write(
          `  ${score.failures.length === 0 ? 'PASS' : 'FAIL'} ${kase.id} · 事件 ${score.incidentTotal}/${score.expectIncidents} · 假设 ${score.hypothesisTotal}${score.failures.length > 0 ? ` · ${score.failures.join('；')}` : ''}\n`,
        );
      }
    } finally {
      if (removed.length > 0) {
        await db.topologyLink.createMany({ data: removed, skipDuplicates: true });
      }
    }
  }

  // 收尾清场：避免评测数据留在演示库里
  await resetDemoData();

  const report: EvalReport = {
    meta: {
      set: options.set === 'all' ? 'dev+test' : options.set,
      mode: reportedMode,
      startedAt: startedAt.toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
      // test 集必须能自证"跑的是哪一版留出集"：哈希打在报告头部，抄进文档后无法悄悄换数据
      manifest: manifestDigest ? manifestDigest.slice(0, 12) : undefined,
    },
    scores,
    agg: aggregate(scores),
  };

  const markdown = renderMarkdown(report);
  process.stdout.write(`\n${markdown}\n`);

  if (options.write) {
    mkdirSync(RESULT_DIR, { recursive: true });
    const slug =
      // live 写到 *-live，README 对得上的规则引擎基线 test.md / dev.md 保持不动
      (options.set === 'all' ? 'all' : options.set) + (reportedMode === 'live' ? '-live' : '');
    writeFileSync(path.join(RESULT_DIR, `${slug}.md`), markdown, 'utf8');
    writeFileSync(
      path.join(RESULT_DIR, `${slug}.json`),
      `${JSON.stringify({ meta: report.meta, agg: report.agg, scores }, null, 2)}\n`,
      'utf8',
    );
    process.stdout.write(`[eval] 结果已写入 evals/results/${slug}.{md,json}\n`);
  }

  await db.$disconnect();
}

main().catch((error) => {
  process.stderr.write(`[eval] 失败：${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
