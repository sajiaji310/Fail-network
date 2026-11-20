import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

/**
 * 评测基线读模型（T09）。
 *
 * 数据直接取 `evals/results/{dev,test}.json` —— 也就是 `npm run eval` 的产物本身，
 * 页面不重算任何指标。这样"页面上看到的分数"和"README 里写的分数"不可能漂移：
 * 两者读的是同一份文件。
 *
 * 文件缺失、没跑过分、产物被改坏，一律返回 null，让页面降级成"尚未跑分"，
 * 而不是把 500 扔给人看。
 */

const AggSchema = z.object({
  total: z.number(),
  top1Rate: z.number(),
  top3Rate: z.number(),
  evidenceRate: z.number(),
  precision: z.number(),
  recall: z.number(),
  compression: z.number(),
  compressionOnPositive: z.number(),
  /** 按「事件 + 孤岛告警」口径的压缩比：用户真正逐条看完的量 */
  compressionOnUserLoad: z.number().optional(),
  avgDurationMs: z.number(),
  suppressionErrors: z.number(),
  passed: z.number(),
  answerable: z.number(),
  // 第 2 阶段新增口径：全部 optional，老产物（没有这些字段）仍能解析，
  // 页面按"有没有"决定要不要显示，而不是报错或显示 0。
  /** 完美聚类下的压缩比上限；压缩比 = 上限 即代表已无可压缩空间 */
  compressionCeiling: z.number().optional(),
  /** 压缩比 / 上限：衡量"该压的都压了吗"，比绝对比值更能反映质量 */
  compressionEfficiency: z.number().optional(),
  /** 处理单元 = 事件 + 孤岛告警，用户真正要逐条看完的条数 */
  handlingUnits: z.number().optional(),
  orphanAlerts: z.number().optional(),
  p95DurationMs: z.number().optional(),
  totalTokens: z.number().optional(),
});

const ScoreSchema = z.object({
  id: z.string(),
  title: z.string(),
  kind: z.string(),
  failures: z.array(z.string()).default([]),
});

const FileSchema = z.object({
  meta: z.object({
    set: z.string(),
    mode: z.string(),
    startedAt: z.string(),
    durationMs: z.number(),
  }),
  agg: AggSchema,
  scores: z.array(ScoreSchema),
});

export type EvalFailure = {
  id: string;
  title: string;
  kind: string;
  failures: string[];
};

export type EvalSummary = z.infer<typeof AggSchema> & {
  set: string;
  mode: string;
  startedAt: string;
  runMs: number;
  failed: EvalFailure[];
};

/** 目标值与 evals/report.ts 的 TARGETS 保持一致；不一致时以那边为准 */
export const EVAL_TARGETS = { top1: 0.5, top3: 0.8, compression: 8 } as const;

export async function getEvalSummary(set: 'dev' | 'test'): Promise<EvalSummary | null> {
  try {
    const file = path.join(process.cwd(), 'evals', 'results', `${set}.json`);
    const parsed = FileSchema.safeParse(JSON.parse(await readFile(file, 'utf8')));
    if (!parsed.success) return null;

    const { meta, agg, scores } = parsed.data;
    return {
      ...agg,
      set: meta.set,
      mode: meta.mode,
      startedAt: meta.startedAt,
      runMs: meta.durationMs,
      failed: scores
        .filter((s) => s.failures.length > 0)
        .map(({ id, title, kind, failures }) => ({ id, title, kind, failures })),
    };
  } catch {
    // 没跑过分 / 文件不存在 / JSON 坏了：都退化成"尚未跑分"，不阻塞概览页
    return null;
  }
}
