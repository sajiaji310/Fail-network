import { z } from 'zod';
import { ScenarioSchema } from '@/modules/ingest/scenario';
import { HypothesisCategorySchema } from '@/modules/rca/schema';

/**
 * 评测场景的数据契约（文档 10.5）。
 *
 * 一个 case = 一套可复现的输入 + 一份人工标注的正确答案。
 * `scenario` 刻意复用注入剧本的 schema：评测数据与演示剧本同构，
 * 意味着"评测里能跑的场景，值班人手动也能一键复现"。
 */

const AnswerSchema = z.object({
  category: HypothesisCategorySchema,
  device: z.string().min(1),
});

export const EvalCaseSchema = z.object({
  id: z.string().regex(/^(dev|test)-\d{2}$/, 'id 形如 dev-01 / test-01'),
  set: z.enum(['dev', 'test']),
  kind: z.enum(['POSITIVE', 'DISTRACTOR', 'ADVERSARIAL']),
  title: z.string().min(2),
  /** 这个场景想考什么，失败时人看得懂 */
  note: z.string().min(2),
  scenario: ScenarioSchema,
  /** 前置数据改造：缺拓扑类场景靠它把链路拿掉 */
  mutations: z
    .object({
      /** "CORE-SW-01|AGG-SW-03"，跑完自动恢复 */
      removeLinks: z.array(z.string()).default([]),
    })
    .default({ removeLinks: [] }),
  /**
   * 分批到达的切分点（分钟偏移）。空数组 = 一次性注入后聚合（默认）。
   *
   * 为什么需要：告警周期规则会把静默 30 分钟后的同指纹上报判为"新周期"，
   * 一次性注入时旧周期行在聚合前就被 RESOLVED 了，跨窗口收敛根本没机会发生。
   * 按波次入库 + 每波聚合一次，才是真实的连续运行方式。
   */
  waves: z.array(z.number().int().min(1).max(239)).default([]),
  expect: z.object({
    /** 业务上应该聚成几个事件 */
    incidents: z.number().int().min(0),
    /** 标注根因；null = 期望系统承认证据不足（AC-20） */
    rootCause: AnswerSchema.nullable(),
    /** 等价答案（多解场景），命中任一即算对 */
    alternatives: z.array(AnswerSchema).default([]),
    /** 标注根因告警：用于算误抑制率（AC-19） */
    rootAlert: z.object({ device: z.string(), type: z.string() }).optional(),
  }),
});

export type EvalCase = z.infer<typeof EvalCaseSchema>;
export type EvalAnswer = z.infer<typeof AnswerSchema>;
