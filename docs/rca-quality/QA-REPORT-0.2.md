# QA 报告 · NetScope 0.2 研判质量专项

> 验收人：测试工程师 严过关 ｜ 日期：2026-11-26 ｜ 判据：`SPEC-0.2.md`（唯一，冲突以它为准）
> 验收对象：**commit `ab6f158`**（BL-4 修复 `55449ee` + 收口 `ab6f158`）

## 0. 快照与作废声明

| 项                 | 实测                                                                                                                                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 验收 rev           | `ab6f158` = 修复 `55449ee`（`split.test.ts` 迁专属租户）+ 收口（docs 修订、溯源文件、16 例基线入库）                                                                                                   |
| 数字适用性         | `git diff --name-status 8b919dc..ab6f158 -- src evals` = 仅 4 个 `evals/results/*` + `split.test.ts`；`-- evals/dataset` **空** ⇒ 生产代码与数据集零改动，A/C 组数字（绑定 `8b919dc`）对交付字节仍适用 |
| 入库产物一致性     | `git show ab6f158:evals/results/test-live.json` 的 `meta.manifest` = `122cb992b271`、`startedAt` = `14:37:52.300Z`、`top1` = 0.857、`reasoning` = 6017/10727 —— 与本轮运行逐项相同，入库的是同一份产物 |
| 清单哈希           | 跑前 16/16 → 跑后 16/16；A/C 两份报告头均为 `122cb992b271`                                                                                                                                             |
| 首次 A 组作废      | 首次运行时工作区不干净（25 项未提交改动），窗口内 `produce.ts` 被修改（22:21:15），无法证明启动进程加载的是哪一版字节；按「验收对象必须是不可变提交」原则作废，经批准后重跑一次，A 组仅此一次          |
| A/C 同源           | C 组 `14:37:37`、A 组 `14:37:52` 启动，同一 rev、同一清单哈希                                                                                                                                          |
| 最终 commit 附加项 | 另含 `docs/STATE.md` 的 0.2 小节（非可执行）：不落在 `src evals/dataset` 判据内，QA 确认可接受，仅要求该 commit 的 `git diff` 对 `src evals/dataset` 为空                                              |

## 1. 门禁结论表（Spec §1.3 逐项，A 组 live 14/2）

| 指标                            | 实测           | 档位              | 判定                              |
| ------------------------------- | -------------- | ----------------- | --------------------------------- |
| Top1                            | 12/14（85.7%） | 目标 ≥11/14       | 达标                              |
| Top3                            | 13/14（92.9%） | 目标 ≥13/14       | 达标（压线）                      |
| 拒答正确率                      | 2/2            | 目标 2/2          | 达标                              |
| 误拒答                          | 0/14           | 目标 0/14         | 达标                              |
| 均值（整条 runAnalysis）        | 6046 ms        | 最低可接受 <8000  | 未达目标（<6000）                 |
| P95（整条 runAnalysis）         | 10793 ms       | 最低可接受 <12000 | 未达目标（<9000）                 |
| `REASONING` 均值                | **6017 ms**    | 最低可接受 <8000  | 未达目标（<6000），**超线 17 ms** |
| `REASONING` P95                 | 10727 ms       | 最低可接受 <12000 | 未达目标（<9000）                 |
| 截断率（`finishReason=length`） | 0/16 = 0%      | 目标 <5%          | 达标                              |
| 规则基线回归（C 组）            | 13/14          | 目标 ≥12/14       | 达标                              |

## 2. 分步记录

### A. 静态门禁（`ab6f158`，QA 独立复跑）

- `npx tsc --noEmit` → exit 0；`npx eslint .` → exit 0；`npm run format:check` → **`All matched files use Prettier code style!`**（全仓）。
- `npx vitest run` ×2 → **两次均 50 文件 / 579 用例全绿**，`skipped=0`（`vitest.config.ts` 的 `process.loadEnvFile('.env')` 注入了 `DATABASE_URL`，5 个 `describe.skipIf(!hasDb)` 块均在跑）。
- `npx vitest run src/modules/incidents/split.test.ts` ×10 → **10/10 全绿**（每次 5 tests）。对照组：修复前在 `8b919dc` 上全量 4 次为 1 红 3 绿 ⇒ 门禁现已可重复。`579` 为真实条数（`581` 已撤回）；evals 四个测试文件只有新增、无删除（断言 1059→1101）。

### B. 反作弊核查（1a09b25 → ab6f158）

| #   | 命令                                                                                     | 结论                                                                                                                                                                                                                   |
| --- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `git diff 1a09b25..HEAD -- src/modules/rca/fallback.ts`                                  | **通过**。`WEIGHT` 40/20/30/15/20/10、`MIN_CANDIDATE_SCORE` 20、`CLASS_SCORE` 20/16/8/4、`SEVERITY_RANK` 4/3/2/1 与 1a09b25 逐字相同；`categoryOf` 仅委托 `categoryOfType`；唯一行为差异 `evidence.slice(0,4)`→`(0,3)` |
| 2   | `grep -nE "CORE-SW-0\|ACC-SW-\|AGG-SW-\|UPSTREAM@\|HARDWARE@" src/modules/rca/prompt.ts` | **通过**，零命中，字典映射不含设备名/标注元组                                                                                                                                                                          |
| 3   | `sha256sum -c MANIFEST.sha256`；`git log -- evals/dataset/test/`                         | 哈希 16/16；数据集仅 `e71d5fe` 一次扩容，此后零改动（BL-1）                                                                                                                                                            |
| 4   | `src/lib/env.ts`                                                                         | **通过**。HINT on(34)/SIGNALS off(36)/GATE on(38)/RESCUE on(40)；GATE=off 注释「关前置 R1 + 关 GATE-02 + 关补位，回到 0.1」；`rescue.ts:97` 实际随 GATE 关闭                                                           |
| 5   | `src/modules/rca/gate.ts:84-99`                                                          | **通过**。ALERT 需 `isExplainedType`、CHANGE 需 `beforeFirstAlert===true`；TOPOLOGY/METRIC/CASE 一律 `return false`                                                                                                    |
| 6   | `grep -rPn "[\x{1F300}-\x{1FAFF}\x{2600}-\x{27BF}]" src evals docs/…`                    | **命中 2 处**：`evals/report.ts:26`、`report.test.ts:54` 的 U+2705/U+274C，预存于 1a09b25，属报告状态标记非 UI 图标 → A-5                                                                                              |
| 7   | 测试面                                                                                   | 断言 1059→1101（+42）；无测试文件删除、无新增 `skip`/`only`；`vitest.config.ts` 未改                                                                                                                                   |

### C. 规则组（`LLM_API_KEY='' npm run eval -- --set=test`）

exit 0。`16 个场景 · 推理模式 fallback`，哈希 `122cb992b271`。Top1 **13/14**、Top3 13/14、均值 **18 ms**、P95 50 ms、全通过 15/16（唯一失败 test-08，Spec §2.2 明确不做）、`hintOnlyTop1` 11/14、`abstainedCases` **0**。
`abstainedCases: 0` 是口径差异不是缺陷：`produce.ts:78-80` 在 `mode==='fallback'` 时先于 R1 直接返回规则结果，规则路径根本不进闸门。

### D. 真实模型组（`npm run eval -- --set=test`，本专项唯一有效一次）

exit 0，16 例，`推理模式 live`，哈希 `122cb992b271`，分母 14/2，用时 85.6s。
Top1 12/14 · Top3 13/14 · 证据相关率 99.2% · 拒答 2/2 · 误拒答 0/14 · 均值 6046 ms · P95 10793 ms · REASONING 6017/10727 ms · 门禁命中 2 例（延迟分母 14）· 截断 0 · `schema_retry` 0 · token 80633（5760/事件）· 全通过 15/16。
`top1ByOrigin` **LLM 12 / 规则补位 0** → 提升不含补位成分。`hintOnlyTop1` **11/14**。GATE-02 在 4 个事件上各清 1 条（`gateCleared:1`×4），均未清到 0、未触发补位（`rescued:false`×18）、Top1 未变。

### E. 逐场景硬断言（读 `evals/results/test-live.json`）

| 用例    | 断言                             | 实测                                                                                     | 结论                   |
| ------- | -------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------- |
| test-07 | `hypotheses.length === 0`        | 0，`abstained=true`，REASONING 0 ms                                                      | 通过                   |
| test-16 | `hypotheses.length === 0`        | 0，`abstained=true`，REASONING 0 ms                                                      | 通过                   |
| test-09 | `> 0`                            | 2，Top1 命中 LINK/AGG-SW-01                                                              | 通过（引用限制见 A-3） |
| test-10 | `> 0`                            | 2                                                                                        | 通过                   |
| test-11 | `> 0` 且每条 `confidence ≤ 0.55` | 3；`topologyLevel=MISSING` → `analyze.ts:202` + `CONFIDENCE_CAP.MISSING=0.55` 结构性封顶 | 通过（代码级证据）     |

拒答路径 `missingInfo` 由 `analyze.ts:179` 注入 `[TYPE_UNKNOWN]` 三段式，结构上非空。延迟三态（G）：有阶段值，均值 6017 ms、P95 10727 ms 均未达 Spec 目标（<6000 / <9000），落最低可接受档（均值从首次作废跑的 5834 ms 到 6017 ms 跨在目标线两侧，目标档不稳定），无 `STAGE_METRICS_MISSING`。

### F. A|C 分层（按 `scores[].id` 对齐 14 例，报计数）

| 分层           | 计数   | 用例              |
| -------------- | ------ | ----------------- |
| A、C 都答对    | **12** | test-02~06、09~15 |
| A 答对、C 答错 | **0**  | —                 |
| A 答错、C 答对 | **1**  | test-01           |
| 都答错         | **1**  | test-08           |

`hintOnlyTop1` 11/14（A、C 同值）；`top1ByOrigin` = LLM 12 / RULE_FALLBACK 0。

## 3. Blocking（全部关闭）

| ID   | 事项                            | 关闭证据                                                                                                                                                                                               |
| ---- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| BL-1 | Spec §4.2 冻结时序              | test-09~16 首现 `e71d5fe 22:14:25`；数据集仅此一次扩容；提交版结果曾为 8 例（11-20 / 11-26T10:06），反证首次 16 例运行（22:20）晚于冻结。`EVAL-PROVENANCE.md` 已入库                                   |
| BL-2 | Spec §3.6 `evidence.max` 保留 8 | `SPEC-0.2.md` §3.6 三列 + 「有意偏差、决策方接受」+ §7 变更记录，已入库；收紧到 3 会结构性拒绝 test-08 类多证据假设                                                                                    |
| BL-3 | 交付物未入库                    | `8b919dc`（实现）+ `55449ee`（测试修复）+ `ab6f158`（收口）                                                                                                                                            |
| BL-4 | `split.test.ts` 非确定性        | `55449ee` 迁至 `split-test` 租户（`beforeEach` 按租户清告警/事件、`runCorrelation(min(6), TENANT)`、`afterAll` 连设备与指纹一并清）。QA 复验：单文件 ×10 = **10/10**，全量 ×2 = **两次 579 全绿**      |
| BL-5 | 关闭依据不在 commit 内          | `ab6f158` 已入库 SPEC §3.6/§7、`EVAL-PROVENANCE.md`、16 例产物、本报告（`fail` 版为当时事实，不回头改）                                                                                                |
| BL-6 | `format:check` 曾使推送必红     | 收口前 6 份文档不合规（含 `PRD`/`ARCH`/`ADR-001` 已进未推送提交）；`ab6f158` 已入库格式化。QA 复跑 `format:check` → 全仓绿。**边界**：`8b919dc` 从未推送、CI 从未运行 ⇒ 当时是「未验证」而非「已失败」 |

BL-2 留痕：Spec 是 QA 提出偏差后追加的（非事前锁定），属「决策方正式接受偏差」的合规路径；「先实现后补授权」应记 0.3 过程改进。

## 4. Advisory（不阻断交付）

- **A-1 不得跨集比较**：旧 8 例 57.1%（4/7）与新 16 例 85.7%（12/14）不是同一份卷子。有效对比只有同集三行：A 12/14 · C 13/14 · hintOnly 11/14。
- **A-2 模型相对规则未观测到增益（已复核，无反例）**：A 独对 0 例；规则组在模型答错的每一例上都答对（test-01）；test-08 两路径同错。模型真正挣到的分 = 0。对外只可主张「拒答门禁与输出收敛达标」。
- **A-3 AC-4 评测层零断言（0.3）**：产品路径由 `gate.ts` 的 `isAttributable` 堵住（引用事后变更的假设会被整条清空），但 `test-09.json` 无该标注、`metrics.ts` 无该检查、`run.ts` 末尾清场 —— 「相信它成立，不是验证了它成立」。0.3 用 `forbid: [{kind:'CHANGE', ref}]` + `scoreCase` 断言；0.2 内不动评测尺子。
- **A-4 token 反向恶化**：80633/14 = 5760 token/事件，超 PRD 不可接受线 5000（基线 5446）。Spec §1.3 无 token 门禁故不阻断，但「延迟只靠裁剪输出体量」的收益未兑现。
- **A-5 emoji（0.3）**：`evals/report.ts:26` 的 U+2705/U+274C 为预存报告状态标记，按规则字面命中、按意图（UI 功能图标）不成立。team-lead 裁决 0.2 保留（改渲染器会让已入库产物与代码漂移），0.3 改 `PASS/FAIL` 文本。另：`schema.ts:55` 的 `hypotheses.min(1)` 本期不放开，PRD §2.1「模型可自行返回空」本期不成立，已登记待办。
- **A-7 GATE-02 观察项**：本轮 4 个事件各清 1 条（Top1 未变、kept 从未清空）。「未过度误杀」的证据就是 kept 从未为 0，建议把 `gateCleared`/`rescued` 纳入长期监控。
- **A-8 环境足迹**：`.next-qa/`（185M/325 文件）被 safe-delete 阈值拦住未删净，需用户在可执行终端 `rm -rf .next-qa`；`.gitignore:41` 的 `.next-*/` 已覆盖，不影响交付。16 例基线已随 `ab6f158` 入库，评分链可从 commit 追溯（`meta.manifest` = `122cb992b271`）。
- **A-10 标注独立性**：8 例由实现方自写自标（`EVAL-PROVENANCE.md` §3 已自认），标注取自 `affinity.ts` 族表而非系统输出，不构成「按答案造题」，但结论强度受限；0.3 应双人独立标注 + 一致性校验。
- **A-11 无租户过滤的设备查询（0.3，范围是全仓排查）**：已核实 `correlation/service.test.ts:267-271`（AC-16 找一对 >2 跳）与 `:458-463`（AC-11 取 25 台）用 `db.device.findMany({ where: { name: { startsWith: 'ACC-SW-' } } })` **不带 `tenantId`**；BL-4 的隔离修法因此要靠 `afterAll` 清设备，若运行被中断留下影子设备，这两处采样仍被污染（与本次 flaky 同一失效类）。生产侧含 `db.device.findMany` 的文件共 6 个需一并复核租户过滤：`correlation/service.ts`、`ingest/resolve.ts`、`ingest/scenario.ts`、`rca/context.ts`、`sources/service.ts`、`topology/service.ts`。0.3 逐个核 `where` 是否带 `tenantId`（本报告不对未逐行核实的位置下断言）。

## 5. 总体判定

**pass —— 可交付。四项延迟指标未达目标但落最低可接受档，按 Spec §1.3 记差距、不阻断。** Spec §1.3 十项无一触碰不可接受线：拒答 2/2、误拒答 0/14、Top1 12/14（目标 ≥11）、Top3 13/14（目标 ≥13）、截断率 0%、规则回归 13/14（目标 ≥12）。四项核心 EARS（test-07/16/09/10/11）行为全部正确，其中 test-11 的 `confidence ≤ 0.55` 由 `capConfidence` + `CONFIDENCE_CAP.MISSING` 结构性保证。

门禁可重复：`tsc`/`eslint`/`format:check` 全绿，`vitest` ×2 均 579 全绿，`split.test.ts` ×10 全绿；反作弊七项无一条因刷分改规则或改测试；`top1ByOrigin` 全为 LLM，提升不含补位成分。

六条阻断（BL-1~BL-6）全部关闭，关闭依据均已入库 `ab6f158`。交付时必须同时披露三条限制：模型相对规则未观测到增益（A-2：A 独对 0 例、规则在模型答错的每一例上都答对）；test 集已饱和（`hintOnlyTop1` 11/14）；AC-4 在评测层无断言（A-3）。0.3 待办：A-3 / A-5 / A-11 与标注独立性（A-10）。
