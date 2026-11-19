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
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadEnvFile } from 'node:process';
import type { LinkStatus } from '@prisma/client';
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

  const { db } = await import('@/lib/db');
  const { resetDemoData } = await import('@/modules/ingest/reset');
  const { runScenarioSpec } = await import('@/modules/ingest/scenario');
  const { runAnalysis } = await import('@/modules/rca/analyze');

  const all = loadCases(options.set);
  const cases = options.only.length === 0 ? all : all.filter((c) => options.only.includes(c.id));
  if (cases.length === 0) throw new Error('没有匹配的场景，检查 --set / --only');

  const startedAt = new Date();
  const scores = [];

  process.stdout.write(
    `[eval] ${cases.length} 个场景 · set=${options.set} · mode=${options.mode}\n`,
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
      const sim = await runScenarioSpec(kase.scenario, {
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
            select: { fingerprint: { select: { device: { select: { name: true } } } } },
          },
        },
      });

      // 证据 ref → 设备名：一次把三张表读进来，避免每条证据一次查询
      const [alertRows, changeRows, linkRows] = await Promise.all([
        db.alert.findMany({
          select: { id: true, fingerprint: { select: { device: { select: { name: true } } } } },
        }),
        db.changeRecord.findMany({ select: { id: true, device: { select: { name: true } } } }),
        db.topologyLink.findMany({
          select: {
            id: true,
            source: { select: { name: true } },
            target: { select: { name: true } },
          },
        }),
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
      for (const incident of incidents) {
        const began = Date.now();
        const outcome = await runAnalysis(incident.id, { force: true });
        const durationMs = Date.now() - began;
        if (!outcome) throw new Error(`${kase.id}: 事件 ${incident.code} 研判返回 null`);

        const hypotheses: ObservedHypothesis[] = outcome.hypotheses.map((h) => ({
          category: h.category,
          cause: h.cause,
          confidence: h.confidence,
          deviceRefs: [...new Set(h.evidence.flatMap((e) => deviceOfRef.get(e.ref) ?? []))],
        }));

        analyses.push({
          code: incident.code,
          source: outcome.source,
          hypotheses,
          dropped: outcome.verify.dropped.length,
          rawEvidence: outcome.verify.stats.rawEvidence,
          validEvidence: outcome.verify.stats.validEvidence,
          durationMs,
        });
      }

      const observation: Observation = {
        alertTotal: sim.alertTotal,
        incidentDevices: incidents.map((i) => [
          ...new Set(i.alerts.map((a) => a.fingerprint.device.name)),
        ]),
        rootAlertSuppressed,
        analyses,
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
      mode: options.mode,
      startedAt: startedAt.toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
    },
    scores,
    agg: aggregate(scores),
  };

  const markdown = renderMarkdown(report);
  process.stdout.write(`\n${markdown}\n`);

  if (options.write) {
    mkdirSync(RESULT_DIR, { recursive: true });
    const slug = options.set === 'all' ? 'all' : options.set;
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
