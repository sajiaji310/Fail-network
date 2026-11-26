# QA 报告 · NetScope 0.2 研判质量专项

> 验收人：测试工程师 严过关 ｜ 日期：2026-11-26 ｜ 判据：`SPEC-0.2.md`（唯一，冲突以它为准）
> A 组真实模型只跑一次，未重跑；C 组确定性重跑无信息增益，亦未重跑。

## 0. 快照声明（先读这一节，否则下面的分数不可复核）

| 项 | 实测 |
| --- | --- |
| git rev | `348d72d`（HEAD），但 **0.2 主体实现不在 HEAD 内**：`git status` 20 个文件未提交，`git diff --stat` = 20 files / +1053 / −234 |
| 验收对象 | 工作区快照 `git diff \| sha1sum` = `06e6322a`（跑 C/A 组时；此后我仅移除自建的 `.next-qa` 一行，现为 `e69d4057`） |
| 并发修改 | `src/modules/rca/produce.ts` mtime **22:21:15 落在 A 组窗口内**（22:20:56 启动 / 22:22:24 结束）。tsx 启动即加载模块，A 组结果未受影响；但「验收期间交付物在变」本身不可接受 |
| 首次 typecheck | 22:19 **红**：`produce.ts(96,7)`/`(128,7)` TS2739 缺 `abstained`/`abstainRule`。22:21 该文件被改（补上两字段），22:26 复跑转绿。**HEAD 版本内部自洽（无 abstained 字段）→ 这次红是工作区「改到一半」的瞬时态，非 HEAD 缺陷** |
| 我的足迹 | `next build` 重排 `tsconfig.json` include 数组（4 行位移，语义不变，已移除我加的 `.next-qa` 行）；`.next-qa/` 构建产物因安全删除被拦仍残留；`evals/results/test*.{md,json}` 被本次运行覆盖（预期） |

## 1. 门禁结论表（Spec §1.3 逐项）

| 指标 | 实测（A 组 live，14/2 分母） | 档位 | 判定 |
| --- | --- | --- | --- |
| Top1 | 12/14（85.7%） | 目标 ≥11/14 | 达标 |
| Top3 | 13/14（92.9%） | 目标 ≥13/14 | 达标（压线） |
| 拒答正确率 | 2/2 | 目标 2/2 | 达标 |
| 误拒答 | 0/14 | 目标 0/14 | 达标 |
| 均值（整条 runAnalysis） | 5871 ms | 目标 <6000 | 达标 |
| P95（整条 runAnalysis） | 10076 ms | 最低可接受 <12000 | 未达目标 |
| `REASONING` 均值 | 5834 ms | 目标 <6000 | 达标 |
| `REASONING` P95 | 10017 ms | 最低可接受 <12000 | 未达目标 |
| 截断率（`finishReason=length`） | 0 / 16 = 0% | 目标 <5% | 达标 |
| 规则基线回归（C 组） | 13/14 | 目标 ≥12/14 | 达标 |

延迟三态：有 `REASONING` 阶段值，**不是「未判定」**；两项 P95 均落在「最低可接受」档，按 Spec 记未达目标。

## 2. 分步记录

### A. 静态门禁（当前快照，22:27 后复跑）
- `npx eslint .` → exit 0；`tsc --noEmit` → exit 0（`--incremental false` 亦 0）；`npx vitest run` → **50 文件 / 579 用例全绿**；`next build`（`Checking validity of types` 已执行）→ exit 0。
- 结论：门禁全绿。**但首次 typecheck 红（见 §0），说明交付物在我手上时仍在被编辑。**

### B. 反作弊核查
| # | 命令 | 结论 |
| --- | --- | --- |
| 1 | `git diff 1a09b25..HEAD -- src/modules/rca/fallback.ts` | **通过**。`WEIGHT` 40/20/30/15/20/10、`MIN_CANDIDATE_SCORE` 20、`CLASS_SCORE` 20/16/8/4、`SEVERITY_RANK` 4/3/2/1 与 1a09b25 **逐字相同**；`categoryOf` 仅委托 `categoryOfType`。唯一行为差异 `evidence.slice(0,4)`→`(0,3)`（Spec §3.6 一致性要求） |
| 2 | `grep -nE "CORE-SW-0\|ACC-SW-\|AGG-SW-\|UPSTREAM@\|HARDWARE@" src/modules/rca/prompt.ts` | **通过**，零命中（exit 1），字典映射无具体设备名/标注元组 |
| 3 | `sha256sum -c MANIFEST.sha256` ／ `git log --evals/dataset/test/` | 哈希 **16/16 OK**（跑分前后各校一次）；**但时序不过**：test-09~16 首次入库于 `e71d5fe` 22:14，晚于全部实现提交 21:57–22:07 |
| 4 | `src/lib/env.ts` | **通过**。`RCA_HINT` on(34)、`RCA_SIGNALS` off(36)、`RCA_GATE` on(38)、`RCA_RESCUE` on(40)；GATE=off 注释写明「关前置 R1 + 关 GATE-02 + 关补位，回到 0.1」；`rescue.ts:97` 实际随 GATE 关闭 |
| 5 | `src/modules/rca/gate.ts:84-99` | **通过**。`isAttributable` 只认 ALERT（需 `isExplainedType`）与 CHANGE（需 `beforeFirstAlert===true`）；TOPOLOGY/METRIC/CASE 走 `return false` |
| 6 | `grep -rPn "[\x{1F300}-\x{1FAFF}\x{2600}-\x{27BF}]" src evals docs/rca-quality docs/decisions` | **命中 2 处**：`evals/report.ts:26`、`evals/report.test.ts:54` 的 U+2705 / U+274C 状态标记。**预存于 1a09b25**，属报告状态标记非 UI 功能图标 → 见 advisory A-5 |
| 7 | 测试面 diff | 断言 `expect(` 1059 → 1101（+42，无下降）；无测试文件删除；无新增 `skip`/`only`；`vitest.config.ts` 未改 |

### C. 规则组（跑在 A 组之前）
`LLM_API_KEY='' npm run eval -- --set=test` → exit 0。报告头：`16 个场景 · 推理模式 fallback`、清单哈希 `122cb992b271`、分母 14/2。
Top1 **13/14**、Top3 13/14、均值 **27 ms**、P95 61 ms、全通过 **15/16**（唯一失败 test-08，Spec §2.2 明确不做）。`hintOnlyTop1` **11/14**，门禁命中 0 例。已写 `evals/results/test.{md,json}`（覆盖旧 8 例基线，预期）。

### D. 真实模型组（A 组，只跑一次）
`npm run eval -- --set=test` → exit 0，16 例，`推理模式 live`，哈希 `122cb992b271`，分母 14/2，用时 83.5s。
Top1 12/14 · Top3 13/14 · 拒答 2/2 · 误拒答 0/14 · 均值 5871 ms · P95 10076 ms · REASONING 5834/10017 ms · 门禁命中（R1）**2 例**（延迟分母 14）· 截断 0 · `schema_retry` 0（JSON 一次通过 100%）· `top1ByOrigin` **LLM 12 / 规则补位 0** · `hintOnlyTop1` **11/14**。
GATE-02 在 test-02 / test-12 / test-14(INC-002) 各清 1 条（均未清到 0，未触发补位；Top1 未变）。跑完再校 MANIFEST：16/16 OK。

### E. 逐场景硬断言（读 `evals/results/test-live.json`）
| 用例 | 断言 | 实测 | 结论 |
| --- | --- | --- | --- |
| test-07 | `hypotheses.length === 0` | 0，`abstained=true`，REASONING 0 ms | 通过 |
| test-16 | `hypotheses.length === 0` | 0，`abstained=true`，REASONING 1 ms | 通过 |
| test-09 | `> 0` | 3（Top1 命中 LINK/AGG-SW-01） | 通过（「不得引用该变更」见 A-2，**未验证**） |
| test-10 | `> 0` | 3 | 通过 |
| test-11 | `> 0` 且每条 `confidence ≤ 0.55` | 3；`topologyLevel=MISSING` → `analyze.ts:202` `capConfidence` + `CONFIDENCE_CAP.MISSING=0.55` 结构性封顶 | 通过（代码级证据，产物未落逐条 confidence） |

`missingInfo` 非空由 `analyze.ts:179` 注入 `ABSTAIN_MISSING_INFO`（`[TYPE_UNKNOWN]` 三段式）保证，C/A 两组的 test-07/16 均走该路径。

### F. A|C 分层（按 `scores[].id` 对齐，14 例，报计数）
| 分层 | 计数 | 用例 |
| --- | --- | --- |
| A、C 都答对 | **12** | test-02~06、09~15 |
| A 答对、C 答错 | **0** | — |
| A 答错、C 答对 | **1** | test-01 |
| 都答错 | **1** | test-08 |

`hintOnlyTop1` 11/14（A、C 两组同值）；`top1ByOrigin` = LLM 12 / RULE_FALLBACK 0。

### G. 延迟三态
有 `REASONING` 阶段值 → 已判定：均值 5834 ms 达标（<6000）；P95 10017 ms 未达目标（<9000），落最低可接受档（<12000）。未出现 `STAGE_METRICS_MISSING`。

## 3. Blocking（不归零不上线）

| ID | 违反 | 证据 | 期望 |
| --- | --- | --- | --- |
| BL-1 | Spec §4.2「新增 8 例必须在任何调参开始前写入并冻结」 | `git log`：test-09~16 首现于 `e71d5fe` 22:14，晚于 `f38d355`~`93101fd`（21:57–22:07）全部实现提交。版本史无法证明冻结先于调参 | 提供冻结早于调参的证据（独立冻结 commit / 原始落盘时间），或按 Spec §3.4 记 CHANGELOG 重跑双基线 |
| BL-2 | Spec §3.6「`evidence.max` 8→3」（锁定项） | `src/modules/rca/schema.ts:46` 仍为 `.max(8)`；`:42-44` 注释为**有意保留**（「prompt 管体量、schema 只管底线」） | 二选一：改回 3；或由决策方正式接受偏差并改 Spec 变更记录。**有意偏差 ≠ 合规**，不能静默通过 |
| BL-3 | 交付物身份 | 0.2 主体实现未入库（20 文件 +1053/−234 全在工作区），且验收期间 `produce.ts` 于 22:21:15 被并发修改 | 收工后提交为单一 commit，用该 rev 复跑 lint/typecheck/test（A 组不必重跑，本次数字对应 06e6322a 快照，已记录） |

## 4. Advisory（不阻断但必须登记）

- **A-1 数字不可作宣传**：`hintOnlyTop1` 11/14 ≈ A 组 12/14，且 **A 独对 0 例、C 独对 1 例**（test-01 规则对、模型错）。test 集同样已饱和，Top1 85.7% 不能归因为模型能力；对外只能讲「拒答门禁与输出收敛达标」，不能讲「模型变准了」。
- **A-2 AC-4 未验证**：test-09「不得引用晚于首告警的变更」无任何自动断言 —— `test-09.json` 的 `expect` 只有 `incidents/rootCause/rootAlert`，`evals/metrics.ts` 无该检查，评测末尾 `run.ts:390` 清场导致产物不可复核。按「没测量 ≠ 达标」，此项记未判定。
- **A-3 延迟未达目标**：REASONING P95 10017 ms 与整条 P95 10076 ms 均未达 Spec 目标，只因 <12000 才落最低可接受。P95 由 test-03/test-14（双事件串行 10s）拉高，单事件其实约 5–6s；口径仍按 Spec 记未达标。
- **A-4 token 反向恶化**：80750 / 14 = **5768 token/事件**，PRD §1 目标 <4000、不可接受线 ≥5000（基线 5446）。输出收敛（`max_tokens=2400`、证据裁剪）没压住 token，反而略升，疑与提示词变长（告警行尾增 `归因:` 标签）有关。Spec §1.3 未设 token 门禁，故不阻断，但「延迟只允许一处来源=裁剪输出体量」的收益未兑现。
- **A-5 emoji 命中需裁决**：`evals/report.ts:26` 的 U+2705/U+274C 为预存报告状态标记，非 UI 功能图标；按团队规则字面「命中即 fail」，按规则意图（UI 功能图标）不成立。建议换成 `PASS/FAIL` 文本，从根上消除歧义。
- **A-6 模型自行拒答路径被堵**：`schema.ts:55` `hypotheses.min(1)` 未改，模型无法返回空假设（PRD §2.1「两条路径都要能拒答」）。Spec §3.6 未要求改，按 Spec 判不阻断，但 PRD 该句应删或标为不做。
- **A-7 GATE-02 观察项**：3 个正例各被清 1 条假设（未影响 Top1）。门禁未过度误杀的证据是「kept 从未被清空到 0」，建议把这两条计数（`gateCleared` / `rescued`）纳入长期监控。
- **A-8 我的足迹**：见 §0 最后一行。

## 5. 总体判定

**fail —— 当前不可交付。** 判据层面好消息：Spec §1.3 十项门禁**全部不触碰不可接受线**，拒答（2/2）、误拒答（0/14）、Top1/Top3、截断率、规则回归均达标，四项核心 EARS（AC-1/2/4/5 对应的 test-07/16/09/10/11）行为正确，反作弊六项无一条因刷分而改规则或改测试。

阻断原因不在模型质量，在三处可修的地方：测试集冻结时序不可证（BL-1）、`evidence.max` 未按锁定 Spec 收到 3（BL-2）、交付物尚未成为一个 commit 且验收期间仍在被改（BL-3）。BL-2/BL-3 各半天内可闭环，BL-1 需要补证据或按 Spec 重跑双基线；三者归零后只需复跑 lint/typecheck/test，A 组不必重跑。
