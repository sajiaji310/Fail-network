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
| T05 | 关联聚合                 | T04  | 待人工验收 |
| T06 | 事件详情（只读拓扑）     | T05  | 未开始     |
| T07 | 根因研判                 | T06  | 未开始     |
| T08 | 人工确认 + 简版报告      | T07  | 未开始     |
| T09 | 评测与发布               | T08  | 未开始     |

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

### T08 人工确认 + 简版报告

- 目标：采纳/否决落库；状态机非法流转 409；报告四段（MTTR/影响面/根因/改进项）
- 改动范围：`src/modules/incidents/stateMachine.ts`、`src/modules/report/**`、`src/modules/case/**`、`src/app/(console)/cases/**`
- 验收：AC-08 / AC-09；`/cases` 关键词可检索到刚结案的案例

### T09 评测与发布

- 目标：test 集跑分出表；两条 E2E 通过；Docker 一键起；README 含真实截图
- 改动范围：`evals/**`、`tests/e2e/**`、`README.md`、`Dockerfile`、`docs/API.md`
- 验收：`npm run eval -- --set=test` 出 Markdown 表；分数如实写入 README（不好看也照写）
