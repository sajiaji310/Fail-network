# NetScope 0.2 研判质量专项 · 架构方案

版本 0.2.0 ｜ 2026-11-26 ｜ 上游 PRD：docs/rca-quality/PRD-0.2.md ｜ 决策记录 ADR-001-hybrid-rca
范围：只动研判链路（context → 门禁 → 规则/LLM → 校验 → 落库）。不动采集、聚合、布局。

## 1. 目标与口径（直接采用 PRD §1，不另立标准）

分母：Top1/Top3/误拒答 = 有标注根因的 14 例；拒答正确率 = `rootCause=null` 的 2 例。

| 指标                                                                       | 规则基线(旧 8) | 模型现状(旧 8)                            | 0.2 目标(新 16)    | 最低可接受 / 不可接受                              |
| -------------------------------------------------------------------------- | -------------- | ----------------------------------------- | ------------------ | -------------------------------------------------- |
| Top1                                                                       | 85.7%          | 57.1%                                     | ≥ 11/14            | 10/14 / ≤ 9/14                                     |
| Top3                                                                       | 85.7%          | 71.4%                                     | ≥ 13/14            | 12/14 / ≤ 11/14                                    |
| 拒答正确率                                                                 | 1/1            | 0/1                                       | 2/2                | — / ≥1 例漏答                                      |
| 误拒答率                                                                   | 0/7            | 0/7                                       | 0/14               | — / ≥2/14                                          |
| REASONING 阶段 均值/P95（整条 runAnalysis 只报告、不设门禁，含 DB 与落库） | 待基线         | 待基线：8969/14991ms 是整条，不能当阶段值 | < 8000 / < 12000ms | — / ≥8000 / ≥15000ms                               |
| 单事件 token                                                               | 0              | ≈5446                                     | < 4000             | — / ≥5000                                          |
| JSON 一次通过率                                                            | —              | ≈89%                                      | ≥ 95%              | — / < 85%                                          |
| 截断率（`finishReason=length`）                                            | —              | 未采集                                    | < 5%               | — / ≥10%（<2% 才允许下调 max_tokens 到 1800 复测） |

延迟口径：Spec 对整条 `runAnalysis` 采用三档（目标 <6000 / 最低可接受 <8000 / 不可接受 ≥8000）；本节 8000/12000 是 `REASONING` 阶段门禁，两者不冲突——整条含取数与落库，只报告；阶段值才是模型性能的判据。

两处 LLM 独有失败的根因（已定位，不重跑）：test-01 是**分类约定没传达**——prompt.ts:77 只渲染 `type/typeLabel`，模型不知道 `ROUTING` 族在本系统约定归 `UPSTREAM`；test-07 是**没有可解释性判据**——verify.ts:143 的 L2 只判存在性与相关性，"引用真实存在的未登记告警"照样通过。

## 2. 目标数据流

```
buildIncidentContext ─► ContextBundle
   ├─► gateContext（纯函数，模型前，只判 R1）──命中──► 直接 ruleFallback：空结论、source=RULE_FALLBACK、tokensUsed=null
   ├─► renderPrompt  +[告警]逐条附「归因字典」  +[设备信号]（RCA_SIGNALS 默认 off）
   │      └─► completeJson(max_tokens=2400, 首调12s/修复8s)
   │            └─► parseResult(zod) ─失败─► 修复重试（受止损门控）─失败─► ruleFallback
   │                                              │ ok
   ├─► ruleFallback(ctx) ─────────────────────────┼─► rescue（仅 kept 为空且来源为 LLM 时补位）
   │                                              ▼
   └──────────────────────► verifyHypotheses ─► gateHypotheses（纵深防御）─► capConfidence ─► persist
                                                                   meta: gate.rule / origin / hintVersion
```

## 3. Q1 归因约定注入（作为字典，不作为答案）

**决策**：把 `classifyAlertType + familyOf → category` 映射以「告警字典」注入，粒度三层：① 逐条告警行尾追加 `| 归因字典:UPSTREAM`（未登记类型附 `| 归因字典:未登记`），约 9 字/条、20 条 ≈180 字，占 13000 字预算 1.4%；② `[告警]` 段头一句「归因字典是类型的默认归类，只用于填 category 字段，不指示根因在哪台设备」；③ SYSTEM_PROMPT 第 6 条冲突条款「现场证据与该默认归类冲突时以现场证据为准，并在 evidence.desc 写明偏离理由」。

**为什么不是作弊**：标注答案是「类别 + 设备」两元组。注入只给"类型→类别"一维，而这是**告警字典的固有属性**（与已渲染的 `typeLabel` 同类，prompt.ts:77）。设备选择完全没给：test-01 里 7 台设备都有告警，模型仍要自己从跳数、告警先后、族共存关系里选出 CORE-SW-01。线上没有标注，但线上同样有这张字典表。

**为什么不污染 confidence**：hint 只进 `prompt.user`，不进 `verifyHypotheses` 与 `gateHypotheses` 的任何判定输入；`confidence` 的唯一外部约束仍是 `capConfidence(topology.level)`（analyze.ts:245）。验收：开关前后 confidence 中位数抬升 >0.10 且准确率不动，即判越界。

**反例检验**：`LINK_DOWN` 的真实成因可能是上游光路衰减（字典给 LINK，事实是 UPSTREAM），这条注入**会**带偏——若模型把"字典归类"读成"根因归属"。三层缓解：
(a) 措辞明确"字典管 category 字段，不管根因位置"；(b) 同设备多族共存时字典给的是互斥的多个默认值，取舍依据是提示词第 4 条因果方向规则，不是字典；(c) 护栏用 PRD §3.4 允许的**对照实验 dev-18**（仅 LINK_DOWN+PORT_FLAP+OPTICAL_RX_LOW，标注 LINK，不进 test、不计分），外加既有 `dev-02`/`dev-11`（LINK_DOWN 存在且标注 LINK）当回归。注入后 category 若从 LINK 漂到 UPSTREAM，即判注入过头，回滚字典行只留冲突条款。

## 4. Q2 规则先验：只给特征，不给结论；补位要标来源

**决策：引入"特征级先验"但首版默认关闭（`RCA_SIGNALS=off`），只上归因字典（A 组）。** 一次上两个变量，分数涨了也无法归因；B 组作为对照实验在 dev 单独跑一次，按 20 点阈值决定是否默认开。

- 拒绝：把 `ruleFallback(ctx)` 的 Top1（含分数与排序）拼进 prompt。那是把答案递给模型——test-01 规则本就答对，提升会全部记在 LLM 账上。
- 采纳（开关打开时）：`[设备信号]` 段只陈述规则排序时用的**同一组事实**，不给 score、不给 rank（如 `- CORE-SW-01（核心层）| 事件内告警 5 条，最高 P1 | 事件前变更 0 | 直连受影响设备 2 台 | 到影响面 0 跳`）。排序与归因仍是模型的活。拼装：`renderPrompt` 内、`[告警]` 之后，数据由 `buildDeviceSignals(ctx)` 产出。

**合并/去重（补位，不是混排）**：LLM 优先。仅当校验与门禁结果为空、且来源是 LLM 时用 `ruleFallback(ctx)` 补位：去重键 `category|主设备名`（主设备名取该假设 ALERT 证据第一条对应设备名）；补位后 `source` 整体置 `RULE_FALLBACK`、`degradedReason` 写「模型未给出可用结论，已由规则引擎补位」；每条假设在 `meta.hypothesesOrigin[]` 标 `LLM | RULE_FALLBACK`。不做"两边各取 N 条混排"——混排会让来源不可分离，正是刷分的温床。

**这是不是刷分：结论级是，特征级不是。给可判定阈值。** 度量（PRD §1 已落）：test 上跑 `A = LLM+字典`（门禁对象）与 `C = 规则引擎同集基线`；`B = LLM+字典+设备信号` **只在 dev 做消融，不占留出集**；附 `top1ByOrigin`（逐假设记 `origin`）与 `hintOnlyTop1` 朴素基线 = "最早告警设备 + 该告警类型字典类别"的准确率。
判据：`B - A ≥ 20 个百分点`（规则与 LLM 原始差距 28.6 点）即判设备信号表等价于答案泄露，保持 `RCA_SIGNALS=off` 不默认开。`top1ByOrigin.LLM` 是披露指标不设硬门禁，但低于 9/14 时交付报告必须写明"提升中含规则补位成分"。

## 5. Q3 拒答门禁（纯函数，两段共用一条判据）

PRD §2.1 要求"调用模型之前"拒答且不花 token；但只看上下文挡不住"上下文里有一条已登记告警、模型却只引用未登记证据"。故**同一判据、两个调用点**，判据只有一份（内部 `isExplainable`）：

```ts
// src/modules/rca/gate.ts
export function gateContext(ctx: GateContext): { hit: boolean; rule: 'R1'; missingInfo: string[] };
export function gateHypotheses(
  ctx: GateContext,
  hypotheses: readonly HypothesisDraft[],
): GateDecision;
```

| 编号            | 判定式                                                                                             | 调用点                  | 动作                                                                                                                                                       |
| --------------- | -------------------------------------------------------------------------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1（前置）      | `alerts.filter(a => !a.suppressed)` 非空 且 无一条 `isExplainedType` 且 无 `beforeFirstAlert` 变更 | `produceResult` 入口前  | 直接 `ruleFallback(ctx)`（本就返回空）：`source` 仍为 `RULE_FALLBACK`、`degradedReason='闸门命中 R1：全部告警类型未登记且无事件前变更'`、`tokensUsed=null` |
| GATE-02（后置） | 某条假设的证据里没有一条「可归因证据」                                                             | `verifyHypotheses` 之后 | 清空该条（逐条，不连坐）                                                                                                                                   |

「可归因证据」只认**已登记类型的 ALERT** 与**早于首告警的 CHANGE**。TOPOLOGY 只说明两台设备相邻、不说明"为什么坏"；CASE 是类比不是本次证据（留着会让模型引用真实案例救活无依据假设，正好绕过 R1 口径）；METRIC 可作辅助，单独存在不足以支撑根因。

三处精度：① 只看**未抑制**告警（`ctx.alerts` 含已抑制项，context.ts:90-111 无 status 过滤）；② 用 `beforeFirstAlert`（context.ts:218 已算好），不重算时间戳；③ 前置命中时**不新增 source 枚举**——`fallbackRate`（evals/metrics.ts:330）与前端都按二值判，加枚举会污染全部历史对比。

**误杀防护（2 个反例，写入单测）**：① `dev-04`（DNS_TIMEOUT+HIGH_LATENCY，全 CHILD，无 ROOT/PARENT，无变更，标注 `UPSTREAM@CORE-SW-01`）——若写成"无设备级告警即拒答"，整个纯链路/质量族（dev-04/06/02/11）会被判死，正是 fallback.ts:26-37 注释记着的那次事故；R1 用 `isExplainedType`，而 DNS_TIMEOUT 在 taxonomy.ts:39-62 属 SUPPRESSIBLE→CHILD，已登记 ⇒ 不触发。②「事件设备只有 UNKNOWN 采集项 + 一条事件前变更」——若写成"无已登记告警即拒答"会误杀配置类根因，R1 有事件前变更即不触发，GATE-02 认 CHANGE 为可归因证据。
刻意**不做**：不按 confidence 阈值判（模型置信度未标定，capConfidence 已管）、不按"无变更记录"判、不按假设条数判、不按拓扑完整度判（PRD §2.1 边界：MISSING 不是拒答理由）。

**清空后写什么**：后置清空时 `kept = []` 走 analyze.ts 既有 `kept.length === 0` 通路，不新开分支——`summary`/`impactScope` → `null`（analyze.ts:276-277、persist.ts:51-53）。前置命中走 `ruleFallback` 时它自带一段默认 missingInfo，**必须用门禁的三段式文案替换**（否则 PRD AC-1/AC-7 不过）：1~5 条，前缀取 `TYPE_UNKNOWN` / `EVIDENCE_THIN`（`TIMING_BROKEN` 只能与 `TYPE_UNKNOWN` 并列出现，**不得单独构成拒答**），至少 1 条是可执行采集动作，黑名单文案（`请提供更多信息`/`建议进一步排查`/`疑似`/`可能存在问题`）进单测断言；`meta.gate = { rule:'R1', hit:true }`（JSON 列，无迁移）满足 PRD AC-2 的"规则编号落库"。

**与 fallback 单一事实来源**：把 `isExplained`（fallback.ts:169-171）与 `categoryOf` 的族映射段（fallback.ts:74-87）外提为 `explainability.ts` 的 `isExplainedType` / `categoryOfType`；fallback、gate、prompt 三处只许 import，任何一处不得重写族判定。fallback 的 `categoryOf` 保留 `change → CONFIG` 前置分支后委托，行为逐字不变（由 fallback.test.ts 锁住）。

## 6. Q4 延迟与 token 预算（不动模型、不加机器）

前置：先用已有 `progress.stages`（progress.ts:35-45）把 `CONTEXT/REASONING/VERIFY/PERSIST` 拆开。evals/run.ts:216-219 的 `durationMs` 覆盖整条 `runAnalysis`，含取数与落库；不拆就不知道 8969ms 里有多少是真解码。下表收益均为**估算，未经实测**。

| #   | 手段                                                                                    | 改动点                                                 | 预估收益                                | 成本 |
| --- | --------------------------------------------------------------------------------------- | ------------------------------------------------------ | --------------------------------------- | ---- |
| 1   | 输出结构收紧：verifySteps 1~2 条、actions ≤1、evidence ≤3、各 desc ≤80 字（= PRD AC-6） | prompt 骨架 + schema 上限                              | 均值 -2500~3500ms（主杠杆）             | 低   |
| 2   | 上下文瘦身：`[历史案例]` 只留 title+tags；指标趋势只留前 3 条带 trend 的                | prompt.ts:106-118、131-139                             | token -1200~1500（token<4000 的主杠杆） | 低   |
| 3   | `max_tokens=2400` + 采集 `usage.completion_tokens` 与 `finishReason`                    | client.ts（当前请求体未传 max_tokens，响应只取 total） | 压尾，消除 4k 级失控输出；截断率进验收  | 极低 |
| 4   | 修复重试止损：`finishReason==='length'`、首调 >6s、超时/网络错误 → 不重试直接降级       | produce.ts                                             | P95 -3000~6000ms                        | 低   |
| 5   | 超时拆分：首调 12s / 修复 8s（现单点 30s，最坏 60s）                                    | client.ts + produce.ts                                 | 最坏用时 60s → 20s                      | 低   |
| 6   | 同事件 in-flight 去重                                                                   | analyze.ts 入口                                        | 不改单次延迟，消除重复点击的二次等待    | 极低 |

口径澄清：PRD §1 规定"延迟只允许一处来源 = 裁剪输出体量，禁止砍候选数量或砍证据校验"。第 1 条是它的执行；第 2 条是 **token<4000** 的执行（单事件 ≈5446 里输入才是大头），不计入延迟收益；第 3~5 条是"对已有失败止损"，不降低一次通过率、不砍候选、不砍校验。
`max_tokens=2400` 依据：按 schema 上限逐字段估，单条假设最坏 ≈1100 token（cause 120 + evidence 3×80 + verifySteps 3×160 + actions 2×120 + 结构字段），3 条 ≈3300；现实输出 1500~2200。**不能按 900 取**——`49017/8≈6127` 是输入+输出的总量，不是输出量，900 会稳定截断并触发第 4 条止损，反而把 `source` 打回 RULE_FALLBACK。验收看**截断率 < 5%**（≥10% 不可接受），截断率 < 2% 才允许下调到 1800 复测。
**能砍/不能砍**：可砍——历史案例正文、指标趋势明细（cases 仅在 ROOT/PARENT 时加 10 分）；不能砍——告警清单（evidence.ref 唯一来源）、拓扑邻接与"晚于首个告警"标注（L2 硬条件与因果方向）、拓扑完整度提示（capConfidence 口径）。
风险提示：延迟门禁按 **REASONING 阶段** < 8000ms / P95 < 12000ms 判，整条 `runAnalysis` 只报告。阶段埋点目前不存在，属本期实现范围；埋点未上线时这两行降级为报告值并标 `STAGE_METRICS_MISSING`，不得用整条 8969/14991ms 当阶段基线。

## 7. 改动清单

| 文件                                                | 函数 / 位置                                                                                                                                                | 性质                  | 行数     |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | -------- |
| `src/modules/rca/explainability.ts`                 | 新增 `isExplainedType`/`categoryOfType`/`buildDeviceSignals`/`attributionTag`                                                                              | 新增纯模块，无 IO     | 新增 ≈75 |
| `src/modules/rca/gate.ts`                           | 新增 `gateContext` + `gateHypotheses`（共用内部判据）                                                                                                      | 新增纯函数            | 新增 ≈75 |
| `src/modules/rca/produce.ts`                        | `produceResult`/`parseResult`/`degradedOutcome` 迁入 + 止损 + max_tokens                                                                                   | 迁移 + 改             | 迁出 ≈65 |
| `src/modules/rca/rescue.ts`                         | 新增 `fillFromRulesIfEmpty`（去重键 + origin）                                                                                                             | 新增                  | 新增 ≈50 |
| `src/modules/rca/fallback.ts`                       | 删本地 `isExplained`；`categoryOf` 委托 `categoryOfType`                                                                                                   | 重构，行为不变        | -8/+6    |
| `src/modules/rca/prompt.ts`                         | 字典标签 + `[设备信号]` + SYSTEM_PROMPT 第 6 条 + `PROMPT_VERSION`→rca-1.1                                                                                 | 改                    | 150→≈165 |
| `src/modules/rca/analyze.ts`                        | 插 `gateContext`（produce 前）与 `gateHypotheses`（verify 后）；missingInfo 分支；调 rescue；meta 增 gate/origin/hintVersion                               | 改                    | 323→≈255 |
| `src/modules/rca/schema.ts`                         | meta 增可选 `gate`/`hintVersion`/`hypothesesOrigin`；`HypothesisSchema` 按 AC-6 收紧上限（类型不变）                                                       | 改（JSON 列，无迁移） | +12      |
| `src/lib/llm/client.ts` / `env.ts` / `.env.example` | `maxTokens?`/`timeoutMs?`/`finishReason`/`completionTokens`；`RCA_HINT`（默认 on）、`RCA_GATE`（on）、`RCA_RULE_FILL`（on）、`RCA_SIGNALS`（**默认 off**） | 改 + 新增开关         | +26      |
| `evals/metrics.ts`                                  | `ObservedHypothesis.origin?`；`Aggregate` 增 `top1ByOrigin`/`hintOnlyTop1`                                                                                 | 改度量，不改判定      | +20      |
| 测试                                                | `explainability.test.ts`/`gate.test.ts`/`rescue.test.ts`/`prompt.test.ts`                                                                                  | 新增                  | ≈4 文件  |

不属于本模块、但 PRD 要求必须排期：① `evals/run.ts` 打印清单哈希、分母校验、不一致非 0 退出，并透出 `origin`/阶段耗时（PRD AC-8）；② 前端研判空态区分"系统拒答"与"研判失败"（PRD §2.3，唯一允许的 UI 改动）；③ test 8→16 扩容与 `MANIFEST.sha256` 冻结、dev-18 对照实验（PRD §3，属 PM/QA）。约束核对：无新增依赖；无 Prisma schema 变更；新文件均 <300 行；analyze.ts 323→≈255。**遗留债**：fallback.ts 现 357 行已超 300，本期只净减 2 行（拆它要动评分权重附近代码，风险大于收益，列入 0.3）。

## 8. 风险与缓解

| 风险                                        | 概率 | 影响                         | 缓解 / 保底                                                                                                      |
| ------------------------------------------- | ---- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 字典注入把 category 拉偏                    | 中   | Top1 反向下降                | dev-18 对照实验 + dev-02/dev-11 回归 + 冲突条款；`RCA_HINT=off` 回滚                                             |
| 设备信号表等价于泄露答案                    | 中   | 分数虚高、线上回落           | 首版 `RCA_SIGNALS=off` 不默认开；`B-A ≥ 20 点`判泄露；`top1ByOrigin` 披露                                        |
| 门禁误杀                                    | 中   | AC-20 反向失败，误拒答率超标 | 判据只留 `isExplainedType`；dev-04 类与"仅变更"类写单测；`RCA_GATE=off`                                          |
| AC-6 收紧后一次通过率跌破 95% / 截断率超 5% | 中   | 触发 PRD 不可接受值          | prompt 骨架与 schema 同批改，"格式不合格"占比 >5% 立即放宽；截断率 ≥10% 先查 max_tokens 与骨架，不得靠加修复重试 |
| 拆 produce.ts 引入回归                      | 低   | 研判主链路                   | 纯迁移 + analyze.test.ts 全绿方算完成；单独 commit                                                               |

## 9. 回滚方式

运行期：`RCA_HINT / RCA_GATE / RCA_RULE_FILL` 置 `off` 重启即回 0.1 行为，无需回滚代码。代码级：按 ① explainability 外提 ② gate ③ prompt 注入 ④ produce 拆分与止损 ⑤ rescue ⑥ schema 上限 拆 6 个独立 commit，逐个可 revert，①③④⑤ 互不依赖。数据级：无——`analysisMeta` 新增字段全部 optional，旧记录读取不受影响（schema.ts:112-115 已走 zod safeParse）。

## 10. PRD 条目 → 架构手段 → 追溯

| PRD 条目                                           | 架构手段                                                              | 追溯的失败场景 / 证据                                     |
| -------------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------- |
| §1 Top1 ≥11/14                                     | Q1 字典注入（A 组）                                                   | test-01（类别判错）；test-13（族内选设备，A 组不保证）    |
| §1 Top3 ≥13/14                                     | Q1 + 补位不混排（保来源可查）                                         | 旧 8 例 Top3 71.4% 的 2 例未命中                          |
| §1 拒答 2/2、误拒答 0/14                           | Q3 R1（前置）+ GATE-02（后置）                                        | test-07/test-16 漏答；test-10/11/05/09 误杀风险           |
| §1 REASONING<8000/P95<12000；token<4000；截断率<5% | Q4 第 1 条（输出）+ 第 2 条（输入瘦身）+ 第 3~5 条                    | P95 14991ms = 一次修复重试双调用；单事件 ≈5446 输入占大头 |
| §1 一次通过率 ≥95%；§4 AC-6 输出体量               | schema 上限收紧与 prompt 骨架同批改                                   | 现状 ≈89%，1 例双调用；输出是延迟主因                     |
| §2.1 R1 / §4 AC-1,2,3                              | `gateContext`，未抑制告警 + `beforeFirstAlert` + `meta.gate.rule`     | test-07、test-16；dev-04、test-10（边界）                 |
| §2.3 拒答文案三段式                                | 门禁生成 missingInfo 替换 ruleFallback 默认文案 + 4 枚举 + 黑名单单测 | PRD §2.3 例                                               |
| §4 AC-8 清单哈希                                   | evals/run.ts（不在本模块，需排期）                                    | PRD §3.4 冻结机制                                         |

本项目内**没有**无法追溯到失败场景的改动（唯一例外是 PRD §5 明确 Out-of-Scope 的 test-08 聚类缺陷：规则基线唯一失败点，保持现状）；若实现期出现无追溯项，按 ADR-001 的 Decision 逐条否决。
