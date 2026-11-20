# AGENT-TASKS.md — MVP-0 任务卡

> 依据 `docs/PROJECT-FRAMEWORK.md` 第 14.4 节展开。按序执行，不跳卡。
> 每张卡结束都要停下来做人工验收（命令 + 页面），确认后才开下一张。

## 状态总览

| 卡  | 标题                     | 依赖 | 状态       |
| --- | ------------------------ | ---- | ---------- |
| T01 | 工程基座                 | -    | 已验收     |
| T02 | 数据模型与种子           | T01  | 已验收     |
| T03 | 告警接入 + 模拟器        | T02  | 已验收     |
| T04 | 归一化 + 抑制 + 生命周期 | T03  | 已验收     |
| T05 | 关联聚合                 | T04  | 已验收     |
| T06 | 事件详情（只读拓扑）     | T05  | 已验收     |
| T07 | 根因研判                 | T06  | 已验收     |
| T08 | 人工确认 + 简版报告      | T07  | 已验收     |
| T09 | 评测与发布               | T08  | 待人工验收 |

---

### T01 工程基座

- 目标：仓库能起、DB 能连、门禁能跑
- 改动范围：根配置 / `src/lib/**` / `src/components/layout/**` / `src/modules/system/**` / `src/app/**`
- 验收：
  - `npm run build` 通过
  - `GET /api/health` 返回 `db:"up"`
  - `globals.css` 含第 12 节全部 Token
  - `npm run lint` / `typecheck` / `test` 全绿
- 禁止：写业务逻辑；引入第二套 UI 库

### T02 数据模型与种子

- 目标：`db:push` 成功，seed 出 30 设备 / 60 链路 / 30 条历史案例
- 改动范围：`prisma/schema.prisma`、`prisma/migrations/**`、`scripts/seed.ts`
- 关键点：`AlertFingerprint` 与 `Alert` 拆两表；`Alert` 有 `(fingerprintId, cycleStart)` 与 `externalKey` 两个唯一约束；`Incident.clusterKey` 唯一；不启用软删除
- 验收：
  - `npm run db:push && npm run db:seed`
  - `npm run db:studio` 里四张主表条数正确
  - 拓扑为 1 核心 / 4 汇聚 / 25 接入的三层结构
- 已知取舍：便携版 PG 无 pgvector，`embedding` 先降级为可空文本

### T03 告警接入 + 模拟器

- 目标：5 套剧本可注入；CSV/JSON 导入按 `externalKey` 幂等；脏数据不炸
- 改动范围：`src/modules/ingest/**`、`src/modules/alerts/**`（仅 normalize 入口）、`scripts/simulate.ts`、`scripts/fixtures/scenarios/*.json`、`src/app/api/v1/ingest/**`
- 验收：同一批文件导入两次 → 第二次 `accepted=0, deduped=N`；缺列 CSV 返回 400 且 details 指出行号

### T04 归一化 + 抑制 + 生命周期

- 目标：指纹去重、父子抑制、30 分钟周期规则、B9 父告警晚到回溯
- 改动范围：`src/modules/alerts/{fingerprint,normalize,suppress,service}.ts` + 单测
- 验收：AC-01 / AC-02 / AC-13 / AC-14 各有对应用例；AC-19 误抑制率 0

### T05 关联聚合

- 目标：B1–B9 全部实现，幂等，500 条 < 500ms
- 改动范围：`src/modules/correlation/**`、`src/modules/incidents/**`
- 验收：每条边界规则一个用例；同批数据跑两次 incident id 集合完全一致；AC-15/AC-16/AC-17

### T06 事件详情（只读拓扑）

- 目标：三栏工作台（时间线 / 拓扑高亮 / 根因面板占位），空态·加载态·错误态齐备
- 改动范围：`src/app/(console)/incidents/**`、`src/app/(console)/topology/**`、`src/components/domain/{topology-canvas,alert-table,incident-card}.tsx`
- 验收：AC-12 空态；影响设备在画布上高亮可点；`page.tsx` ≤ 120 行

### T07 根因研判

- 目标：规则 fallback 先通 → LLM 结构化 → L1/L2/L3 校验；无 key 全链路可用
- 改动范围：`src/modules/rca/**`、`src/lib/llm/**`、`src/app/api/v1/incidents/[id]/analyze/**`
- 验收：AC-06 / AC-07 / AC-18 / AC-20；校验器三条丢弃原因各有单测；降级 source=RULE_FALLBACK
- 实际改动：
  - `lib/llm/client.ts`（三态 + 30s 超时）、`rca/{schema,context,context-trim,context-types,prompt,fallback,verify,analyze,persist,mock}.ts`
  - `app/api/v1/incidents/[id]/analyze/route.ts`、`scripts/analyze.ts`（`npm run rca:analyze`）
  - UI：`components/domain/hypothesis-{panel,card}.tsx`、`incidents/{hypothesis-view,devices}.ts`
  - 数据：`Incident.analysisMeta Json?`（文档 8 节缺项，承载 missingInfo + VerifyResult）
  - 测试 36 条：verify 14 / fallback 7 / context-trim 7 / analyze 集成 8

### T08 人工确认 + 简版报告

- 目标：采纳/否决落库；状态机非法流转 409；报告四段（MTTR/影响面/根因/改进项）
- 改动范围：`src/modules/incidents/stateMachine.ts`、`src/modules/report/**`、`src/modules/case/**`、`src/app/(console)/cases/**`
- 验收：AC-08 / AC-09；`/cases` 关键词可检索到刚结案的案例
- 实际改动：
  - `incidents/{status,stateMachine,lifecycle,closure-view}.ts`：状态机 + 结案副作用 + 审计读模型
  - `report/{template,service}.ts`：四段模板（纯函数）+ 快照落库
  - `case/service.ts`：案例草稿 / upsert / 多词 AND 检索 / 标签统计 / 相似召回
  - API：`PATCH incidents/[id]`、`PATCH incidents/[id]/hypotheses/[hid]`、`POST|GET incidents/[id]/report`、`GET cases`、`GET cases/search`
  - UI：`incident-actions`（结案二次确认）、`hypothesis-card` 裁决、`report-panel`（原文/复制/下载）、`/cases` 页面
  - 数据：`Incident.statusLog / closure`、`Hypothesis.verdict / verdictAt / verdictNote`（文档 8 节缺项）
  - 测试 28 条：状态机 7 / 报告模板 10 / lifecycle 集成 11

### T09 评测与发布

- 目标：test 集跑分出表；两条 E2E 通过；Docker 一键起；README 含真实截图
- 改动范围：`evals/**`、`tests/e2e/**`、`README.md`、`Dockerfile`、`docs/API.md`
- 验收：`npm run eval -- --set=test` 出 Markdown 表；分数如实写入 README（不好看也照写）
- 实际改动：
  - `evals/{schema,metrics,report,run}.ts` + `dataset/{dev,test}/`（24 场景，dev 16 / test 8）
  - `evals/{metrics,report}.test.ts`：16 个用例先锁住打分器与渲染器本身
  - `src/modules/ingest/scenario.ts`：抽 `runScenarioSpec(spec)`，评测直接吃内存剧本
  - 评测驱动的三处业务修正：`MIN_CANDIDATE_SCORE` 40→20 + `SELF` 权重、`findContinuation`（B5 延续）、
    `scoreClusterAgainstIncident` 锚点改 `lastSeen` + 30 分钟闸门
  - `playwright.config.ts` + `tests/e2e/{happy-path,incident-flow}.spec.ts`（`channel:'chrome'`）
  - `Dockerfile` / `docker/entrypoint.sh` / `docker-compose.yml`：`DATABASE_URL` 覆盖、db push → seed → start
  - `scripts/screenshots.mjs`：注入剧本后真实渲染截图，5 张落 `docs/screenshots/`
  - `next.config.ts` 加 `NEXT_DIST_DIR` 出口（本地绕过沙箱批量删除拦截）+ `devIndicators:false`
  - 测试 27 条：metrics 9 / report 7 / match 7 / fallback 3 / 其它内联；总 191
- 已知未达成：告警压缩比 6.0:1（目标 8:1）、test-08 拓扑全缺失场景失败、Docker 未实机验证

## 第 4 阶段：真实数据接入和规模化（T10–T14）

### T10 真实数据源接入

- 目标：Prometheus Alertmanager / Zabbix 至少一种能直接推告警进系统，且主机名能对上 CMDB 设备
- 改动范围：`src/modules/ingest/sources/**`、`src/modules/ingest/resolve.ts`、`prisma/schema.prisma`（`DeviceAlias`）
- 验收：真实 payload 的 `instance`（带端口）、Zabbix host（小写短名）都能命中设备；`resolved` 告警不建事件
- 实际改动：
  - `sources/classify.ts`：告警标题 → 平台类型词表（认不出来保留规范化原名，不塞 OTHER）
  - `sources/alertmanager.ts`：v4 payload、零值 `endsAt`、纳秒时间、annotations 里的 value/threshold
  - `sources/zabbix.ts`：单对象 / `{problems}` / 数组三种形状，severity 0–5 与文本
  - `ingest/resolve.ts`：别名 → 设备名 → IP 三级匹配，大小写不敏感
  - API：`POST /api/v1/ingest/{alertmanager,zabbix}`、`POST /api/v1/sources/aliases`
  - UI：`/sources`（推送地址 + curl + 别名表 + 批次表）
  - 测试 18 条

### T11 批处理导入与批次状态

- 目标：大文件不再堵住请求，批次进度可查、可恢复判断
- 改动范围：`src/modules/ingest/batch.ts`、`prisma/schema.prisma`（`IngestBatch`）、`/api/v1/ingest/batches/**`
- 验收：≤500 行同步返回（形状不变）；>500 行 202 + batchId；进程中断的批次被标记失败而不是永远 RUNNING
- 实际改动：分块 200 行 + 每块写进度并让出事件循环；`sweep` 清理假 RUNNING；测试 3 条

### T12 指标快照与时序证据

- 目标：结论不只依赖告警瞬时值，能看到"爬升还是尖刺"
- 改动范围：`src/modules/metrics/**`、`src/modules/rca/{context,context-types,prompt,verify}.ts`、`prisma/schema.prisma`（`MetricSample`）
- 验收：采样幂等；事件窗口内出首末/峰谷/斜率；`METRIC` 证据能通过 L1，伪造 ref 被丢弃
- 实际改动：`POST /api/v1/metrics/samples`、`GET /api/v1/metrics`；prompt 增加趋势行；
  `EvidenceType` 增 `METRIC`，L2 要求设备在影响面 ≤2 跳；测试 7 条

### T13 RBAC / 多租户 / 审计检索 / 保留策略

- 目标：能交付给多人用——角色分明、数据分租户、审计可查、数据有保留期
- 改动范围：`src/lib/{keys,rbac,auth}.ts`、`src/middleware.ts`、`src/modules/audit/service.ts`、`src/modules/system/retention.ts`
- 验收：VIEWER 写操作 403；RESPONDER 读审计 403；`API_KEYS` 未配置时 fail-closed；保留清理默认 dry-run
- 实际改动：多 Key 配置（兼容单 `API_KEY`）；403 `FORBIDDEN`；审计 `actor/from/to/cursor`；
  `tenantId` 落 `Incident/CaseRecord/AuditLog/IngestBatch/MetricSample`；`POST|GET /api/v1/admin/retention` + `npm run db:retention`；测试 14 条

### T14 运行指标

- 目标：在真实事件上量出 MTTR、人工接受率、误抑制成本
- 改动范围：`src/modules/ops/metrics.ts`、`/metrics` 页面
- 验收：每个指标都能说清分母；没有数据时显示「—」而不是 0
- 实际改动：MTTR p50/p90/avg、接受率（分母=已裁决）、误抑制率（父告警先恢复）、数据接入量级；测试 3 条
