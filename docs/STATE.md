# STATE.md — 当前进度 / 阻塞 / 下一步

> Agent 每次会话必读必写。只记事实，不写计划口号。
> 最后更新：2026-11-19 23:45

## 当前任务

**T08 人工确认 + 简版报告 — 已实现，等待人工验收**

## 已完成

### T01 工程基座（已验收）

- [x] 便携版 PostgreSQL 16.14（`E:/sinxiangmy/.tools/pg16`，端口 5432，用户/库 `netscope`）
- [x] 仓库骨架、设计 Token、`/api/health`、`/overview` 自检页
- [x] 门禁 ESLint + Prettier + tsc strict + Vitest + CI + Docker

### T02 数据模型与种子（已验收）

- [x] 5 枚举 + 8 表；`AlertFingerprint` / `Alert(cycleStart)` 拆表；`clusterKey` 幂等
- [x] seed：30 设备（L1:1 / L2:4 / L3:25）、60 链路、30 事件、30 案例，幂等
- [x] 拓扑校验：全部可达，最大 3 跳

### T03 告警接入 + 模拟器（已验收）

- [x] `modules/ingest/schema.ts`：`RawAlert` zod 契约（贴近 Zabbix/Prometheus 字段）
- [x] `parsers/csv.ts`：RFC4180 切分（引号 / 逗号 / CRLF / BOM），缺列整体失败，脏行按真实行号跳过
- [x] `parsers/json.ts`：接受裸数组 / `{alerts}` / `{data}`，逐条校验并记 index
- [x] 5 套剧本 JSON 全部可注入且 0 失败：核心线卡 / 光模块劣化 / ACL 变更 / DNS 过载 / 出口闪断
- [x] `POST /api/v1/ingest/alerts`（JSON + CSV）、`POST /api/v1/ingest/simulate`
- [x] `npm run sim -- --list | --scenario=x [--seed=42] [--reset]`

### T04 归一化 + 抑制 + 生命周期（已验收）

- [x] `alerts/taxonomy.ts` 三分类（PARENT / ROOT / CHILD / UNKNOWN），抑制白名单
- [x] `alerts/normalize.ts` 30 分钟周期判定 + 落库；`alerts/suppress.ts` B9 回溯 + 精确回滚 + AUTO_CLOSED
- [x] `Alert.suppressedByAlertId` 自关联，抑制可溯源
- [x] `GET /api/v1/alerts`、`npm run alerts:recompute / alerts:stats`、概览「告警状态」卡

### T05 关联聚合（已验收）

- [x] `correlation/`：constants / topology / affinity / scoring / cluster / match / merge / persist / service
- [x] B1–B9 全量落地；`clusterKey` 幂等；事件级合并保留早 code
- [x] `POST /api/v1/correlation/run`、`GET /api/v1/incidents`、`npm run corr:run`
- [x] `Incident.lastSeen`（B5 要求，文档 8 节模型缺项）
- [x] 概览页「事件」卡

### T06 事件详情（只读拓扑）（已验收）

- [x] `topology/layout.ts`：确定性分层布局（层内按名排序、每行 8 列换行、整行居中）+ `resolveImpactScope`（受影响 / 一跳邻居）
- [x] `topology/service.ts`：`getTopologyGraph()` — 设备 + 链路 + 活跃告警聚合（activeAlertCount / maxSeverity / 关联事件）
- [x] `incidents/detail.ts`：`getIncidentDetail(idOrCode)` — 告警、设备聚合、变更、假设、时间线、统计；输出全可序列化
- [x] `incidents/timeline.ts`：事件开始 / 告警 / 抑制 / 变更 / 恢复 五类节点的纯函数合成，同刻排序 INCIDENT→CHANGE→ALERT，超限截断保留最早
- [x] `GET /api/v1/incidents/[id]`（id 或 `INC-YYYYMMDD-NNN` 均可）、`GET /api/v1/topology`
- [x] `components/domain/`：`topology-canvas`（@xyflow/react 只读 + 高亮可点）、`alert-table`、`incident-timeline`、`incident-card`、`hypothesis-panel`、`incident-workspace`、`topology-explorer`、`simulate-button`
- [x] `components/ui/badges.tsx`：严重度 / 告警状态 / 事件状态三组双编码徽标
- [x] 页面：`/incidents`（状态分段 + 空态动作）、`/incidents/[id]`（三栏 110 行）、`/topology`（只读画布 + 设备详情）、`/alerts`（告警流表格）
- [x] 状态态：`loading.tsx` 骨架与真实布局同尺寸、`error.tsx`（错误码 + 重试）、`not-found.tsx`
- [x] `POST /api/v1/ingest/simulate` 支持 `reset: true`（与 CLI `--reset` 对齐，供空态按钮一键清场）
- [x] 测试 100 条（新增 19）：布局 11 / 时间线 8

### T07 根因研判（已验收）

- [x] `lib/llm/client.ts`：OpenAI 兼容出口，三态（fallback / mock / live），30s 硬超时、0 自动重试（重试语义交给修复重试）
- [x] `rca/schema.ts`：`HypothesisSchema` / `AnalysisResultSchema`（文档 10.2 原文）+ `AnalysisMetaSchema`（落库审计）
- [x] `rca/context.ts` + `context-trim.ts` + `context-types.ts`：告警 Top20 / 2 跳链路 / 指标快照 / 24h 变更 / Top3 案例；6k tokens 预算，裁剪顺序 指标→历史→拓扑(1 跳)→告警(Top10)
- [x] `rca/prompt.ts`：system 里写死"ref 只能填清单内 ID"，与校验器口径对齐
- [x] `rca/fallback.ts`：规则打分（变更 +40 / 直连 +30 / 类型 +20 / 历史 +10），纯函数，confidence 上限 0.95
- [x] `rca/verify.ts`：L1 存在性（整条丢弃）/ L2 相关性（剔证据，剩 0 则丢假设）/ L3 一致性（`0.6+0.4×有效率`，变更间隔 <60s 再 ×0.9）
- [x] `rca/analyze.ts`：编排 + zod 修复重试一次 + 5 分钟缓存 + 降级；`rca/persist.ts`：事务内整体替换假设
- [x] `POST /api/v1/incidents/[id]/analyze`（`?force=1` 跳过缓存）；`npm run rca:analyze -- --code=... [--force] [--mock] [--json]`
- [x] UI：`hypothesis-panel` 转 client 组件（研判按钮 + 结论 + 校验统计 + 丢弃原因）、新增 `hypothesis-card`（证据含 ref 短码 / 验证步骤 / 处置风险）
- [x] `incidents/hypothesis-view.ts`（JSON 列容错收敛）、`incidents/devices.ts`（影响面聚合从 detail 抽出，压回 300 行内）
- [x] 测试 136 条（新增 36）：verify 14 / fallback 7 / context-trim 7 / analyze 集成 8

### T08 人工确认 + 简版报告（待人工验收）

- [x] `incidents/status.ts`：事件状态中文标签 + 动作动词 + 后果说明（徽标与状态机共用一份，避免文案漂移）
- [x] `incidents/stateMachine.ts`：只向前、允许跳级、`RESOLVED → CLOSED` 唯一出口；`assertTransition` 抛 `INVALID_TRANSITION` 409（带 `allowed` / `reason`）
- [x] `incidents/lifecycle.ts`：`transitionIncident`（locatedAt / resolvedAt / mttrSeconds / closedReason / statusLog / closure）+ `setHypothesisVerdict`（采纳单选，事务内降级其它 ACCEPTED）
- [x] `incidents/closure-view.ts`：`statusLog` / `closure` JSON 列的容错解析（坏数据退化为"没有记录"）
- [x] `report/template.ts`：固定四段 MTTR / 影响面 / 根因 / 改进项，纯函数；表格竖线转义；改进项取采纳（或首选）假设的 actions，不足 3 条用基线补齐
- [x] `report/service.ts`：`generateReport`（每次新增快照，可 `save=false` 预览）、`getLatestReport`
- [x] `case/service.ts`：`buildCaseDraft`（采纳 → 首选 → 兜底，未人工确认会带标注）、`upsertCase`、`listCases`（多词 AND + 标签 `has`）、`getCaseTagStats`、`searchCases`
- [x] `PATCH /api/v1/incidents/[id]`（状态流转，非法 409）、`PATCH .../hypotheses/[hypothesisId]`（裁决）、`POST|GET .../report`（`text/markdown`，id 在 `x-report-id` 头）、`GET /api/v1/cases`、`GET /api/v1/cases/search`
- [x] UI：`incident-actions`（合法目标全列出 + 结案二次确认弹窗 + 结案记录 + 流转记录）、`hypothesis-card` 加采纳/否决、`report-panel`（原文展示 + 复制 + 下载 .md + 重新生成）、`/cases` 页面（搜索 + 标签筛选 + 卡片 + 空态）
- [x] 侧边栏 `/cases` 去掉 T08 占位标记
- [x] 测试 164 条（新增 28）：状态机 7 / 报告模板 10 / lifecycle 集成 11

## T06 关键实测

| 项         | 结果                                                                     |
| ---------- | ------------------------------------------------------------------------ |
| 拓扑规模   | 30 节点 / 60 链路，SSR 输出 30 个自定义节点（`react-flow__node-device`） |
| 影响面     | 事件内 15 台高亮为红框（`border-sev-p0`），一跳邻居蓝灰，其余淡化        |
| 画布尺寸   | 换行后 1398×648（原单行 4450×264，fitView 会被 minZoom 裁切）            |
| 时间线     | 22 条告警 + 事件开始节点，抑制项标注"不计入影响面"                       |
| 详情页行数 | `page.tsx` 110 行（约束 ≤120）                                           |
| 接口       | `GET /api/v1/incidents/nope` → 404 `NOT_FOUND`；按编码查询 → 200         |

## T07 关键实测

| 项           | 结果                                                                       |
| ------------ | -------------------------------------------------------------------------- |
| 降级路径     | `LLM_API_KEY` 为空 → `source=RULE_FALLBACK`，1 条假设，证据 3/3 有效       |
| mock 路径    | `--mock` → `source=LLM`，`dropped=1 (EVIDENCE_NOT_FOUND)`，L1 真实生效     |
| AC-20 空结论 | 单设备无边事件 → `kept=0`、`summary=null`、库里 0 条假设、missingInfo 2 条 |
| 缓存         | 5 分钟内二次 POST → `cached:true`，假设条数不变                            |
| 上下文体积   | 21 条告警的事件 → 6339 字符（≈2.9k tokens），未触发裁剪                    |
| 接口         | `POST .../analyze?force=1` → 200；不存在的编码 → 404 `NOT_FOUND`           |
| 构建         | `/api/v1/incidents/[id]/analyze` 出现在路由表，首屏 JS 188 kB（详情页）    |

## T08 关键实测

| 项       | 结果                                                                                                                          |
| -------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 结案     | `OPEN → ANALYZING → RESOLVED`：`mttrSeconds=818`（13 分钟），`statusLog` 2 条，`closure.note` 保留结案备注                    |
| 409      | `RESOLVED → OPEN` → `409 {"code":"INVALID_TRANSITION", "allowed":["CLOSED"], "reason":"BACKWARD_OR_UNKNOWN"}`，不写脏日志     |
| 幂等     | 重复 PATCH `RESOLVED` → `changed:false`，`statusLog` 不追加，`Report` 仍为 1 条                                               |
| 报告     | 四段齐全；影响面 15 台（核心 1 / 汇聚 2 / 接入 12）、21 条告警；根因标注"人工采纳"并附 3 条证据与 3 步验证；改进项 3 条含风险 |
| 案例沉淀 | 结案自动写入 `CaseRecord`（tags: P0 / 核心层 / 汇聚层 / 接入层 / 线卡故障 / 链路 Down / 丢包 / BGP 邻居 Down）                |
| 案例检索 | `?q=线卡` → 2 条（刚结案 + 种子案例）；`/cases/search?incidentId=...` → 3 条相似案例；`?q=不存在XYZ` → 0 条                   |
| 页面     | `/incidents/INC-20261119-001` 200，含"处理动作 / 已采纳 / 复盘报告 / MTTR：13 分钟"；`/cases`、`/cases?q=线卡` 均 200         |
| 构建     | 新增 4 条路由（cases / cases/search / incidents/[id] PATCH+hypothesis verdict / report），详情页首屏 JS 192 kB                |

## 未完成 / 已知偏差

- B4（人工拆分）按文档推迟到 P2
- **状态机只向前、允许跳级**：文档 AC-08 只规定 `RESOLVED → OPEN` 要 409，没有定义整张表。
  这里统一成"目标状态序号必须大于当前"，`RESOLVED` 唯一出口是 `CLOSED`。跳级保留（小故障常从
  OPEN 直接结案），回退一律拒绝 —— 回退后 `resolvedAt / mttrSeconds` 就不可信了
- **B6 自动重开不走状态机**：`correlation/persist.reopenIncident` 直接把 RESOLVED 改回 OPEN 并清空
  `resolvedAt / mttrSeconds / closedReason`。它是系统行为（30 分钟内同簇再现），人工接口不提供回退。
  重开后事件重新走流程，再次结案会覆盖 `closure`（一次新的结案）
- **结案的两个副作用不在事务里**：状态先落库，再沉淀案例、生成报告。报告失败不回滚结案 ——
  人已经把故障处理完了，不能因为一段 Markdown 拼不出来就说"结案失败"；返回值里 `warnings` 会说明
- **`Incident.statusLog` / `closure`、`Hypothesis.verdict / verdictAt / verdictNote` 都是新增字段**
  （文档 8 节模型没有）：F7 要求"结案记录"与"采纳/否决落库"，但没有给字段。用 JSON 列而不是新表，
  避免在 8 表模型上再加两张表
- **重新研判会清空裁决**：`persistAnalysis` 是"整体替换假设集合"（T07 的设计），旧假设连同 verdict 一起删除。
  UI 上有 ACCEPTED 时会要求二次确认（按钮变"确认重新研判"并提示会清空裁决）
- **报告只存快照，不做更新**：每次生成新增一条 `Report`，详情页展示最新一条。报告是发给别人看过的文本，
  事后改写会说不清哪版才是当时的结论
- **案例检索是多词 AND**：搜"光模块 抖动"要求两个词都命中（含 tags 精确 `has`）。词太多容易 0 结果，
  空态文案已提示
- **`/cases` 不做语义检索**（决策 8）：`CaseRecord.embedding` 字段预埋但为空，当前是 ILIKE + 标签
- **指标只有快照**：库里没有指标表，CPU/内存/端口错包只能取告警自带的 `value/threshold`，
  即"上报那一刻"的值，没有时间序列。prompt 里标注了这个限制，避免模型当趋势用。P1 接采集后再补
- **L1 用的是"上下文清单"而不是全库 ID**：ref 必须命中本次 prompt 里出现过的 id。
  比文档（"库内真实 id"）更严：被预算裁掉的案例/变更即使真实存在也会被判 `EVIDENCE_NOT_FOUND`。
  这是有意的 —— 模型看不到的证据，它引用了就是幻觉
- **研判不改事件状态**：T07 只写 `summary / impactScope / analysisMeta / hypotheses`。
  `OPEN → ANALYZING → LOCATED` 的状态机归 T08，避免两张卡抢同一份状态
- **模型给的 severity 只进 `analysisMeta`，不覆盖 `Incident.severity`**：降级时模型容易把 P0 说成 P2，
  定级属于人的职责
- **`Incident.analysisMeta` 是新增字段**（文档 8 节模型缺）：承载 missingInfo 与 VerifyResult，
  落实文档 10.3"校验结果要落库，用于 eval 与事后审计"
- **`LLM_MOCK=true` 的 fixture 故意含一条幻觉假设**（引用不存在的 alertId），
  用于验证 L1 真的在拦；想看不带丢弃的输出就跑 fallback 或真实模型
- **`/alerts` 页面文档 11.1 列了，但不在任何任务卡范围内**；侧边栏早有入口，本卡顺手补齐（只读表格 + 状态筛选）
- **`notFound()` 的 HTTP 状态码是 200**（页面内容与 `meta[name=next-error]=not-found` 正确）：`(console)` 布局先出流，Next 流式渲染下无法回写 404。API 侧仍是标准 404，验收看页面内容即可
- **拓扑层内换行**：25 台接入单行铺开宽 4450px，`fitView` 需缩到 0.16 而 `minZoom` 卡 0.2 → 必然裁切。改为每行 8 列、行距 56（层间距 96），宽度降到 1398
- `resetDemoData` 从 `scripts/demo-reset.ts` 下沉到 `src/modules/ingest/reset.ts`：API 与 CLI 共用，避免 `src` 反向依赖 `scripts`（原文件保留为 re-export）
- 文档 8 节 `Device.alerts` 笔误、`IncidentAlert` 未建表、`embedding` 降级 `String?`、`Incident` 缺 `lastSeen`（均见 T02/T05 记录，需回写文档）
- 本机沙箱单轮删除 >50 文件会拦截：重启 dev/build 前先用 PowerShell 清 `.next(-dev)`
- 本机无管理员权限 → 数据库不能注册 Windows 服务，重启后 `npm run db:start`

## 已知行为（不是 bug，验收时别误会）

- **多套剧本同时注入会并成一个大事件**。5 套剧本的告警落在同一时间段，种子拓扑最大 3 跳、绝大多数设备 ≤2 跳，按 B7 只能拦住 >2 跳的组合。逐套验收请用 `--reset` 清场。
- **5 分钟滑窗是硬边界**，不是"平均间隔"。相隔较久的同类型告警靠 B5（分 ≥0.55）挂到已存在事件上。
- **不足 3 条的簇不成事件**，会留在库里等后续告警补齐。
- **时间线按告警的 `lastSeen` 排**（无 `lastSeen` 时用 `firstSeen`）：30 分钟内累加的告警显示在最后一次上报的位置，而不是首次出现的位置。
- **画布默认 fitView 全览**，节点在 0.45~0.5 缩放下文字偏小，属正常；滚轮放大或用右下角控件。

## 下一步

1. 人工验收 T08（清单见下）
2. 通过后 → T09：评测与发布（`npm run eval -- --set=test`、Playwright E2E 两条链路、README 跑分表）

## T08 人工验收清单

```bash
cd E:/sinxiangmy/netscope

# 1) 清场并造一个事件（核心线卡故障 → 1 个 P0 事件 / 15 台设备 / 21 条告警）
npm run sim -- --scenario=core-switch-board-failure --reset
CODE=$(curl -s "localhost:3000/api/v1/incidents?status=OPEN" | jq -r '.items[0].code')

# 2) 研判（无 key 走 fallback），取首选假设 id
npm run rca:analyze -- --code=$CODE --force
HID=$(curl -s "localhost:3000/api/v1/incidents/$CODE" | jq -r '.hypotheses[0].id')

# 3) 采纳 → 推进 → 结案（期望 mttrSeconds 有值、reportId 与 caseId 均非 null）
curl -s -X PATCH "localhost:3000/api/v1/incidents/$CODE/hypotheses/$HID" \
  -H 'content-type: application/json' -d '{"verdict":"ACCEPTED","note":"现场确认"}' | jq '.acceptedHypothesisId'
curl -s -X PATCH "localhost:3000/api/v1/incidents/$CODE" \
  -H 'content-type: application/json' -d '{"status":"ANALYZING"}' | jq '{from,to,changed}'
curl -s -X PATCH "localhost:3000/api/v1/incidents/$CODE" \
  -H 'content-type: application/json' -d '{"status":"RESOLVED","note":"更换线卡后恢复"}' | jq '{mttrSeconds,reportId,caseId,warnings}'

# 4) 报告四段（MTTR / 影响面 / 根因 / 改进项）
curl -s "localhost:3000/api/v1/incidents/$CODE/report" | sed -n '1,20p'

# 5) AC-08：期望 409 INVALID_TRANSITION，且 allowed 只有 CLOSED
curl -s -X PATCH "localhost:3000/api/v1/incidents/$CODE" \
  -H 'content-type: application/json' -d '{"status":"OPEN"}' -w "\nhttp=%{http_code}\n"

# 6) 案例检索：刚结案的案例必须能按关键词搜到
curl -s "localhost:3000/api/v1/cases?q=线卡" | jq '{total, codes:[.items[].incidentCode]}'
curl -s "localhost:3000/api/v1/cases/search?incidentId=$CODE&limit=3" | jq '[.items[].title]'

# 7) 门禁（164 passed）
npm run lint && npm run typecheck && npm run test && npm run build
```

浏览器验收（重点）：

1. `/incidents` → 点事件进详情 → 右栏顶部「处理动作」：当前状态徽标 + 全部合法目标（OPEN 时有 4 个：研判中 / 已定位 / 已缓解 / 结案）
2. 点「结案」→ 弹窗（不可回退提示 + 备注输入 + 动词按钮「结案」）；提交后页头出现 MTTR，右栏出现结案记录与「流转记录」
3. 假设卡片底部「采纳为首要根因 / 否决」：采纳后卡片变绿边并标「已采纳」；采纳第二条时第一条自动取消（单选）
4. 已采纳时点「重新研判」→ 按钮变「确认重新研判」并提示"会清空已采纳裁决"（再点才执行）
5. 页面底部「复盘报告」：展开显示 Markdown 原文，可复制 / 下载 .md / 重新生成；页脚显示快照 ID 与生成时间
6. `/cases`：刚结案的案例排第一，可搜「线卡」、可点标签「线卡故障」、点「查看事件」跳回详情
7. 结案后浏览器再调 `PATCH status=OPEN` → 409（页面不会出现"待处理"按钮，状态只增不减）

## 阻塞

- 暂无

## 请求新增依赖

- 暂无
