# Spec · NetScope 0.2 研判质量专项

> 生成日期：2026-11-26 ｜ 状态：**已锁定（开发依据）**
> 基于：`docs/rca-quality/PRD-0.2.md`（修订版）+ `docs/rca-quality/ARCH-0.2.md`（修订版）+ `docs/decisions/ADR-001-hybrid-rca.md`
> 裁决原则：**本 Spec 与 PRD/ARCH 冲突时，以本 Spec 为准。**

## 1. 目标与基线

### 1.1 基线（实测，非估算）

| 路径 | 数据集 | Top1 | Top3 | 均值 | P95 | token/事件 |
| --- | --- | --- | --- | --- | --- | --- |
| 规则引擎 `fallback` | dev 17 例 | 86.7% (13/15) | 93.3% (14/15) | 28ms | — | 0 |
| 真实模型 `live` | dev 17 例 | 73.3% (11/15) | 86.7% (13/15) | 7195ms | 13940ms | 5916 |
| 规则引擎 `fallback` | test 8 例 | 85.7% (6/7) | 85.7% (6/7) | 40ms | 94ms | 0 |
| 真实模型 `live` | test 8 例 | 57.1% (4/7) | 71.4% (5/7) | 8969ms | 14991ms | 6127 |

### 1.2 失败归因（本专项要解决的全部问题）

| 编号 | 现象 | 根因（已定位到行） | 对应对策 |
| --- | --- | --- | --- |
| F1 | test-01 / dev-02 / dev-06 / dev-17 的 category 判错 | `prompt.ts:77` 只渲染 `type/typeLabel`，未传达系统归因约定（`affinity.ts:11-70` 的 `FAMILY_OF_TYPE`） | 归因字典注入 |
| F2 | test-07 / dev-14 该拒答却编结论 | `schema.ts:47` `hypotheses.min(1)` 逼模型必须给假设；`verify.ts` 只查证据真伪与相关，不查可解释性 | 两段式门禁 |
| F3 | test 均值 8969ms、P95 14991ms | 输出字段冗长 + schema 修复重试（P95 那次是两次调用） | 输出收敛 + 止损 + max_tokens |
| F4 | test-08 事件未覆盖 CORE-SW-01 | 属 correlation 聚类，两条路径同时失败 | **不做**（见 §2.2） |

### 1.3 目标（test 集扩到 16 例后）

分母：**Top1 / Top3 / 误拒答 = 14 例有标注根因**；**拒答正确率 = 2 例 `rootCause=null`**（分母仅 2，只判"有无漏答"，不判比率）。

| 指标 | 目标 | 最低可接受 | 不可接受 | 判定命令 |
| --- | --- | --- | --- | --- |
| Top1 | ≥ 11/14（78.6%） | 10/14 | ≤ 9/14 | `npm run eval -- --set=test` |
| Top3 | ≥ 13/14（92.9%） | 12/14 | ≤ 11/14 | 同上 |
| 拒答正确率 | 2/2（零漏答） | 2/2 | ≤ 1/2 | 同上 |
| 误拒答（该答却空） | 0/14 | 1/14 | ≥ 2/14 | 同上 |
| 均值（整条 runAnalysis） | < 6000ms | < 8000ms | ≥ 8000ms | 同上 |
| P95（整条 runAnalysis） | < 9000ms | < 12000ms | ≥ 12000ms | 同上 |
| `REASONING` 阶段均值 | < 6000ms | < 8000ms | — | 同上 |
| `REASONING` 阶段 P95 | < 9000ms | < 12000ms | — | 同上 |
| 截断率（`finishReason=length` 占比） | < 5% | < 10% | ≥ 10% | 日志 `llm_truncated` |
| 规则基线回归 | ≥ 12/14 | 11/14 | < 11/14 | `LLM_API_KEY= npm run eval -- --set=test` |

**取舍顺序（写死）**：拒答正确率 > Top3 > Top1 > 延迟 > token。宁可 Top1 低 1 例，不接受该拒答的场景编出结论。

## 2. 范围

### 2.1 做

1. 归因字典注入（`RCA_HINT`，默认 **on**）。
2. 设备信号段（`RCA_SIGNALS`，默认 **off**，仅作 B 组对照实验）。
3. 前置拒答门禁 R1 + 后置 GATE-02（`RCA_GATE`，默认 on）。
4. 输出契约收敛 + `max_tokens=2400` + 修复止损 + 超时拆分。
5. 空结论补位（`RCA_RESCUE`，默认 on）。
6. 评测：test 集扩到 16 例并冻结；metrics 增加来源分账。

### 2.2 不做（拒绝理由必须可追溯，防止范围蔓延）

| 不做 | 原因 |
| --- | --- |
| test-08 的聚类缺陷 | correlation 模块问题，两路径同错；同期改动会让分数变化无法归因 |
| SSE / 流式 | 1.5s 轮询可用；换传输层属架构变更 |
| UI 改版 / 设计 token / 图标 | 本专项零 UI 改动；拒答空态复用现有"证据不足"渲染 |
| 新增 `source` 枚举（如 `ABSTAINED`） | `metrics.fallbackRate` 与前端均按二值判断，加枚举会污染历史对比 |
| 结论级规则先验（把 `ruleFallback` 的 Top1 拼进 prompt） | 等于递答案，提升无法区分是模型还是规则 |
| 拒答规则 R2（变更全晚于首告警）/ R3（证据量过薄） | R2 会误杀 test-05（其变更晚于首告警但告警可归因）；R3 为规则造场景，生产上低置信结论优于拒答 |
| 按假设位次裁剪字段（Top2/3 省略 verifySteps） | `verifySteps` 是 `min(1)`，前端统一渲染；改必填性属 UI 契约变更 |
| 换模型 / 多模型对比 | 同一模型上先证明提示词有效 |
| 案例语义检索 / 新数据源 | 与 Top1 主矛盾无关 |

## 3. 技术方案（锁定）

### 3.1 单一事实来源：`src/modules/rca/explainability.ts`（新增）

```ts
// 与 fallback.ts 原 isExplained 等值（classifyAlertType !== 'UNKNOWN' || familyOf !== 'OTHER'）
export function isExplainedType(type: string): boolean;

// 与 fallback.ts 原 categoryOf 的类型映射段等值；未登记类型返回 null
export function categoryOfType(type: string, alertClass: AlertClass): HypothesisCategory | null;

// 提示词用标签：'UPSTREAM' | 'LINK' | ... | '未登记'
export function attributionTag(type: string, alertClass: AlertClass): string;

// 仅供 B 组实验：事实陈述，不含 score、不含 rank
export function buildDeviceSignals(ctx: ContextBundle): DeviceSignal[];
```

`fallback.ts` 删除本地 `isExplained`，`categoryOf` 的 change 分支保留后委托 `categoryOfType`。**行为必须逐字不变**，由 `fallback.test.ts` 现有用例锁定。

### 3.2 归因字典注入：`prompt.ts`

- `[告警]` 段每行行尾追加 `| 归因:X`；未登记写 `| 归因:未登记`。
- 段头加一句：`归因是告警类型的默认归类，只用于填 category 字段，不指示根因在哪台设备；与现场证据冲突时以证据为准，并在 evidence.desc 写明偏离理由。`
- `SYSTEM_PROMPT` 增第 6 条：`category 字段优先采用归因标签；若现场证据明确指向另一类，可覆盖，但必须在 evidence.desc 说明理由。`
- 输出收敛写进 SYSTEM_PROMPT：`evidence 最多 3 条、desc 每条 ≤80 字；verifySteps 1~2 条；actions 最多 1 条；hypotheses 最多 3 条。`
- `PROMPT_VERSION` → `rca-1.1`；`RCA_HINT=off` 时不渲染归因标签（回滚用）。

### 3.3 两段式拒答

**前置 R1**（`produce.ts` 内，`llm` 分支入口）

```
命中条件：ctx.alerts.filter(a => !a.suppressed) 非空
      且 该集合 every(a => !isExplainedType(a.type))
      且 ctx.changes.filter(c => c.beforeFirstAlert).length === 0
```

> 精度要求：`ctx.alerts` 含已抑制告警（`context.ts` 取数未按 status 过滤），必须显式过滤 `!a.suppressed`，否则"已登记告警全被父告警抑制"的场景会被误判为无人可归因。变更侧一律复用 `c.beforeFirstAlert`，不得重算时间戳——两套口径必然漂移。

命中 → 直接 `ruleFallback(ctx)` 返回：`source='RULE_FALLBACK'`、`tokensUsed=null`、`degradedReason='闸门 R1：全部告警类型未登记且无事件前变更，证据不足以归因'`。不得调用模型。

**后置 GATE-02**（`gate.ts`，`verifyHypotheses` 之后）

```
对每条假设：若其 evidence 中不存在「可归因证据」，整条清空
可归因证据 = ALERT 且 isExplainedType(该告警 type)
           | CHANGE 且该变更 beforeFirstAlert === true
TOPOLOGY / METRIC / CASE 一律不算
```

清空后走 `analyze.ts` 现有 `kept.length === 0` 通路：`summary=null`、`impactScope=null`、`missingInfo` 与门禁文案取并集后截断 5 条。`analysisMeta.gate = { cleared, reasons }`。

### 3.4 空结论补位：`rescue.ts`

仅当 `kept.length === 0` 且 `source === 'LLM'` 且 `RCA_RESCUE=on` 时，用 `ruleFallback(ctx)` 补位：
- 去重键 `category|主设备名`（主设备名取该假设 ALERT 证据第一条对应设备）；
- 补位后 `source='RULE_FALLBACK'`、`degradedReason='模型未给出可用结论，已由规则引擎补位'`；
- `meta.hypothesesOrigin[]` 逐条标 `LLM | RULE_FALLBACK`。

若 `ruleFallback` 本身返回空（如 R1 场景），保持空结论，**不得**为凑数编造。

### 3.5 延迟预算

| 手段 | 落点 | 约束 |
| --- | --- | --- |
| `max_tokens=2400` | `client.ts` 请求体 | 截断率 ≥5% 上调至 3000；<2% 方可下调 1800 |
| 记录 `finishReason` + `completion_tokens` | `client.ts` | 截断打日志 `llm_truncated` |
| 修复止损 | `produce.ts` | `finishReason==='length'` / 首调 >12s / 超时 / 网络错误 → 不重试，直接降级 |
| 超时拆分 | `client.ts` | 首调 12000ms，修复 8000ms（现为单点 30000ms） |
| 上下文瘦身 | `prompt.ts` | 历史案例只留 title+tags；指标趋势只留前 3 条带 trend 的 |
| in-flight 去重 | `analyze.ts` | 同 incidentId 并发共享 Promise，不改单次延迟 |

**不能砍**：告警清单（`evidence.ref` 唯一来源）、拓扑邻接与"晚于首个告警"标注（L2 硬判据）、拓扑完整度提示（`capConfidence` 口径）。

### 3.6 输出契约收敛：`schema.ts`

| 字段 | 现值 | 新值 |
| --- | --- | --- |
| `evidence.max` | 8 | 3 |
| `Evidence.desc.max` | 160 | 80 |
| `verifySteps.max` | 5 | 3 |
| `actions.max` | 5 | 2 |

只收紧上限，不改类型、不改必填性。`AnalysisMeta` 增可选 `gate` / `promptHint` / `hypothesesOrigin`（JSON 列，无迁移）。

## 4. 评测协议

1. `evals/dataset/test/` 从 8 例扩到 **16 例**（14 有标注根因 + 2 拒答）。
2. 新增 8 例（`test-09`~`test-16`），**必须在任何调参开始前写入并冻结**：

| 编号 | 类型 | 考点 | 标注 |
| --- | --- | --- | --- |
| test-09 | POSITIVE | 已登记告警 + 一条晚于首告警的变更 → **必须出结论**，且不得引用该变更 | 有根因 |
| test-10 | POSITIVE | 10 条告警中 3 条未登记、7 条已登记指向根因 → **必须出结论** | 有根因 |
| test-11 | POSITIVE | 拓扑 MISSING 但单设备可定向 → **必须出结论**，confidence ≤0.55 | 有根因 |
| test-12 | POSITIVE | 资源过载（CAPACITY 正例，本集缺失的类别） | 有根因 |
| test-13 | POSITIVE | 上游族内选对设备（两个 UPSTREAM 候选） | 有根因 |
| test-14 | ADVERSARIAL | 双故障，其一由事前变更引起 | 有根因（2 事件） |
| test-15 | DISTRACTOR | 症状是资源告警、真根因是 HARDWARE（与 test-12 双向对照） | 有根因 |
| test-16 | ADVERSARIAL | 全未登记多设备、无事件前变更 → 必须拒答 | `rootCause=null` |

3. 冻结机制：`evals/dataset/test/MANIFEST.sha256` 记录 16 个文件的哈希；报告头部打印清单哈希；哈希不符时评测脚本非 0 退出。
4. 调参只用 dev（17 例 + `dev-18` 反例检验），**test 只在最后跑一次**。
5. 三组数的跑法（**留出集只花一次**，PRD AC-8 的"三组同时报"按此收窄）：
   - `A = LLM + 字典`（`RCA_SIGNALS=off`）：**在 test 上跑一次，作为最终交付数字**；
   - `C = 规则引擎`：**在 test 上跑一次**（确定性、不调用模型，不构成留出集泄漏）；
   - `B = A + 设备信号`（`RCA_SIGNALS=on`）：**只在 dev 上做消融**，不得在 test 上二次跑。
   报告需单列 `top1ByOrigin` 与 `hintOnlyTop1`（"最早告警设备 + 字典类别"的朴素基线）。
   - `origin` 必须**逐假设**记录（`ObservedHypothesis.origin`），不得沿用 `evals/metrics.ts:159` 的 `obs.analyses[0].source`——那个是"按事件取第一个分析"，多假设/多事件会失真。
   - `origin=LLM` 的 Top1 作为**来源披露指标**，不设独立硬门禁；若低于 9/14，交付报告必须显式写明"提升中含规则补位成分"，不得只报总分。
   - 延迟统计**必须剔除门禁命中例**（R1 命中不调用模型，耗时接近 0，会把均值机械性拉低），并单列"门禁命中 N 例"。否则会把"没调模型"误读成"模型变快了"。
   - 延迟门禁落在 `REASONING` 阶段（`progress.stages`），整条 `runAnalysis` 只报告不设门禁：现有 8969ms 含取数与落库，拿它定模型性能目标会把 DB 耗时算成模型问题。
6. 判据：若 dev 上 `B - A ≥ 20` 个百分点，判定设备信号等价于答案泄露，`RCA_SIGNALS` 保持 off 并从文档撤回该段。

## 5. 验收标准（EARS）

1. `While` 事件未抑制告警 100% 为未登记类型且无事件前变更，`When` 请求研判，`Then` 返回空 `hypotheses`、`summary=null`、`missingInfo` 非空，且本次 `tokensUsed=null`（未调用模型）。
2. `While` 存在已登记类型告警，`Then` 系统不得以 R1 拒答，必须输出 ≥1 条假设（test-10 验证）。
3. `While` 事件有变更但全部晚于首告警、告警类型已登记，`Then` 必须输出 ≥1 条假设且不得引用该变更（test-09 验证）。
4. `While` 拓扑完整度为 MISSING 且仅 1 台设备上报根因告警，`Then` 必须输出假设且每条 `confidence ≤ 0.55`（test-11 验证）。
5. `When` 假设的证据仅由 TOPOLOGY / METRIC / CASE 构成，`Then` 该条必须被门禁清空，且 `analysisMeta.gate.reasons` 记录原因。
6. `While` `RCA_HINT=on`，`Then` 每条告警行必须带 `归因:` 标签；`RCA_HINT=off` 时不得出现该标签。
7. `When` 模型输出被 `max_tokens` 截断，`Then` 不得重试，直接降级并记 `llm_truncated`。
8. `When` 跑 test 集，报告头部必须打印清单哈希；哈希与 `MANIFEST.sha256` 不一致或分母不是 14/2 时，脚本以非 0 退出。
9. `While` `RCA_GATE=off`，`Then` 两条门禁均不生效，行为回到 0.1（回滚验证）。

## 6. 风险与回滚

| 风险 | 缓解 | 一键回滚 |
| --- | --- | --- |
| 字典把 category 带偏（`LINK_DOWN` 实为上游引起） | `dev-18` 对照场景 + SYSTEM_PROMPT 第 6 条冲突条款 | `RCA_HINT=off` |
| 门禁误杀 | 三条"不该拒答"边界用例（test-11/12/13）+ GATE-02 只认 ALERT/CHANGE | `RCA_GATE=off` |
| 输出上限收紧触发更多修复 | 截断一律不重试，直接降级；监控截断率 | 放宽 schema 上限 |
| 拆 `produce.ts` 引入回归 | 纯迁移，先单独 commit，`analyze.test.ts` 全绿再继续 | revert 该 commit |

## 7. 变更记录

| 日期 | 变更 | 原因 |
| --- | --- | --- |
| 2026-11-26 | 初版锁定 | 基于 PM 修订版 PRD + 架构师修订版 ARCH；裁决删除 R2/R3、`max_tokens` 2400、test 16 例 |
