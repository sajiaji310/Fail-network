# NetScope v0.1.0

**发布日期**：2026-11-21 · **范围**：MVP-0 纵向闭环 + 第 2/3/4 阶段 · **License**：MIT

> 把一堆同源告警压成少数事件，给出可解释的根因候选，并让每一步都能被质疑：
> 结论带证据 ref、带 L1/L2/L3 校验统计、由人裁决、结案后留下 MTTR 与报告。
> 这个版本的目标不是"演示能跑"，而是**陌生运维人员能在安全边界内找到下一步动作**。

## 这个版本里有什么

| 阶段                 | 内容                                                                                                                                      |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| MVP-0（T01–T09）     | 归一化/抑制/生命周期 → B1–B9 关联聚合 → 事件详情（只读拓扑）→ LLM 研判 + 证据校验 → 人工裁决与报告 → 评测与发布                           |
| 第 2 阶段（T09 补）  | 跨窗口收敛、拓扑完整度标注、事件拆分、压缩比口径（按处理单元）                                                                            |
| 第 3 阶段            | 接手与响应时限、三类待处理队列、验证步骤勾选、业务影响面、研判阶段进度                                                                    |
| 第 4 阶段（T10–T16） | Alertmanager/Zabbix 真实接入、设备别名、异步批次、指标快照与 `METRIC` 证据、RBAC/多租户/审计检索/保留策略、运行指标页、验收脚本、回填压测 |

页面：`/overview`（值班看板）、`/incidents`、`/incidents/[id]`、`/topology`、`/alerts`、`/cases`、`/sources`、`/metrics`、`/settings`。

## 数字

- **316 个单测（41 文件）+ 2 条 Playwright E2E**，`format / lint / typecheck / test / build` 全绿
- **留出集（未参与调参）**：Top1 85.7% · Top3 85.7% · 证据相关率 100% · 压缩效率 100%（贴住数据集上限）·
  9 个场景 7 个全通过，失败项是「拓扑全缺失」，README 与事件详情页都如实标注
- **回填压测**（1.2 万条 / 24h 历史 / 独立临时库）：36.2s · 331 行每秒 · 去重 20.0% · 设备不存在 4.9%
- **验收脚本**：15 项断言，`npm run accept:phase4 -- --write` 实测 PASS 15 / FAIL 0

## 快速开始

```bash
# Docker
docker compose up --build -d          # http://localhost:3000

# 本地
cp .env.example .env                  # LLM key 可留空，研判自动降级规则引擎
npm install && npm run db:start
npm run db:push && npm run db:seed
npm run dev
```

接真实数据源：`/sources` 页有三条可复制的推送地址（Alertmanager / Zabbix / 指标采样），
主机名对不上就到同页的别名表里加一条 `core-sw-01.lab → CORE-SW-01`。

## 从 0.0.x 升级要知道的事

1. **表结构**：13 → 17 张表（新增 `DeviceAlias` / `MetricSample` / `IngestBatch` / `Tenant` 等），
   `Incident` 新增 `assignee / team / claimedAt / slaMinutes / tenantId`。跑 `npm run db:push` 或 `prisma migrate`。
2. **写接口要 Key**：`APP_ENV=production` 下 `/api/v1/*` 的写操作需要 `x-api-key`；
   `API_KEYS` 支持 JSON 数组配角色与租户（`VIEWER < RESPONDER < ADMIN`），只配 `API_KEY` 时视为 ADMIN + default。
   配置缺失时**拒绝服务**（500 `SERVER_MISCONFIG`），不静默放行。
3. **大批量导入语义变了**：超过 `INGEST_SYNC_LIMIT`（默认 500 行）返回 **202 + `batchId`**，
   结果要轮询 `GET /api/v1/ingest/batches/[id]`。小批量（≤500）的响应形状与旧版一致。
4. **新错误码 `FORBIDDEN`（403）**：401 是"不认识你"，403 是"你不能做这个"，响应体带 `required / actual` 角色。
5. **审计查询改游标分页**：`GET /api/v1/audit?cursor=<ISO>&limit=`，返回 `nextCursor`；无 offset 参数。
6. **保留策略默认 dry-run**：`POST /api/v1/admin/retention` 不加 `{"dryRun":false}` 只报数量不删除。

## 已知限制（照实说）

- **Docker 未实机验证**：本机没有 docker，Dockerfile / compose 只做了逐行校对，本地等价路径（build + start + health）验过
- **多租户是"Key 绑定租户 + 查询过滤"**，不是行级安全：`Device.name` 仍全局唯一，两个租户不能有同名设备
- **批次执行在进程内**：状态落库、推进靠本进程，重启会让批次中断（`sweep` 标 FAILED）；多副本要换外部队列
- **指标是采样快照不是 TSDB**：没有降采样与长期存储，要这些应接 Prometheus
- **历史告警不能回放**：聚合只取仍为 ACTIVE、且 `lastSeen` 在最近 2 小时内的告警；告警周期静默 30 分钟即结束。回填 24 小时历史后事件数几乎不变（9000 条入库只出 48 条候选）
- **页面不做鉴权**：只有 `/api/v1/*` 走 RBAC，控制台仍由反向代理/内网保护
- **接手没有身份校验**：`assignee` 是自由填写的名字（要"只能接自己的单"需要用户表与登录态）
- 完整清单见 `docs/STATE.md` 的「未完成 / 已知偏差」

## 本版之后的修正（2026-11-26，尚未打 tag）

上面「已知限制」里有三条已经过期，以这里为准：

- **「页面不做鉴权」已不成立**：production 下页面要 `CONSOLE_PASSWORD` 换 12h HttpOnly cookie，
  没配口令直接 500；登录后调 `/api/v1/*` 写接口不再需要另带 API Key（等同 ADMIN + default 租户）。
  local / staging 仍不拦，E2E 与评测不受影响。
- **「历史告警不能回放」已不成立**：`POST /api/v1/correlation/run` 接受 `{from,to}`，按告警自己的时间重放聚合。
- **「Device.name 仍全局唯一」已不成立**：设备名、别名、事件编号均已改为租户内唯一。

其余限制仍然有效：Docker 未实机、批次/研判进度/限流在进程内、指标是采样快照而非 TSDB、接手没有身份校验。

另外本轮统一了 413 错误码（声明超限与流式读取超限现在都是 `PAYLOAD_TOO_LARGE`），
并补上了真实模型的留出集结果 —— 见 `evals/results/test-live.md` 与 README「真实模型对照」。

## 验收入口

```bash
npm run accept:phase4                 # 只读：15 项断言
npm run accept:phase4 -- --write      # 加上真实源 + 指标 + 批次链路
npm run accept:phase4 -- --clean      # 清掉验收数据（审计保留）
npm run eval -- --set=test            # 留出集跑分
npx playwright test                   # 两条 E2E
```

## 文档

`README.md`（能力与截图）· `docs/API.md`（接口/RBAC/错误码）· `docs/STATE.md`（进度、偏差、验收清单）·
`docs/AGENT-TASKS.md`（T01–T16 任务卡）· `docs/PRODUCT-ENGINEERING-REVIEW.md`（阶段目标与验收指标）
