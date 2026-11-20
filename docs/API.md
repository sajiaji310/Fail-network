# API 契约（NetScope MVP-0）

> 与 `docs/PROJECT-FRAMEWORK.md` 第 9 节一致；本文件只记录**已实现**的端点，未实现的不写。
> 约定：全部 JSON；成功 `200/201`；错误统一 `{ error: { code, message, details? } }`；
> 列表统一 `{ items, total, page, pageSize }`；每个响应都带 `x-trace-id`。

## 关键错误码

| code                    | HTTP | 场景                                              |
| ----------------------- | ---- | ------------------------------------------------- |
| `VALIDATION_FAILED`     | 400  | zod 校验失败，details 带字段路径                  |
| `UNAUTHORIZED`          | 401  | production 下缺 `x-api-key` 或 key 不匹配         |
| `NOT_FOUND`             | 404  | 资源不存在                                        |
| `INVALID_TRANSITION`    | 409  | 事件状态非法流转（含 AC-08 的 `RESOLVED → OPEN`） |
| `ALREADY_CLAIMED`       | 409  | 事件已被他人接手，`details` 带当前责任人          |
| `INCIDENT_CLOSED`       | 409  | 事件已结束，不能再变更处理人                      |
| `DUPLICATE_FINGERPRINT` | 409  | 唯一键冲突                                        |
| `PAYLOAD_TOO_LARGE`     | 413  | 请求体超过 `BODY_LIMIT_BYTES`（默认 2MB）         |
| `RATE_LIMITED`          | 429  | 触发 IP 滑动窗口限流，`details.retryAfter=60`     |
| `LLM_UNAVAILABLE`       | 503  | 模型超时且降级也失败                              |
| `INTERNAL`              | 500  | 兜底，日志带 traceId                              |

## 系统

| Method | Path          | 说明             | 备注                                                                                               |
| ------ | ------------- | ---------------- | -------------------------------------------------------------------------------------------------- |
| GET    | `/api/live`   | 存活探针         | 不查库，进程活着就 200；用于容器 `livenessProbe`                                                   |
| GET    | `/api/ready`  | 就绪探针         | 查库；库不可用返回 503，用于 `readinessProbe`                                                      |
| GET    | `/api/health` | 健康检查（脱敏） | `{status, db:'up'\|'down', llm:'live'\|'mock'\|'fallback', traceId}`；数据库错误只进日志，不出响应 |

## 安全边界

| 维度     | 规则                                                                                                  |
| -------- | ----------------------------------------------------------------------------------------------------- |
| 鉴权     | 仅 `APP_ENV=production` 生效：`/api/v1/*` 写方法 + `/api/v1/audit` 读方法需要 `x-api-key`；local 放行 |
| 限流     | 全环境按 IP 滑动窗口：写 30/min、读 120/min（`RATE_LIMIT_WRITE_PER_MIN` / `RATE_LIMIT_READ_PER_MIN`） |
| 请求体   | 声明超限由中间件直接 413；chunked 上传由 `lib/http/body.ts` 边读边计数，超限立即断流                  |
| 数据库   | `docker-compose.yml` 端口绑 `127.0.0.1`，不对外暴露                                                   |
| 健康检查 | 不返回数据库错误原文、连接串、主机名                                                                  |

## 告警

| Method | Path                      | 说明         | 关键参数                                                                                   |
| ------ | ------------------------- | ------------ | ------------------------------------------------------------------------------------------ |
| GET    | `/api/v1/alerts`          | 告警列表     | `?status=ACTIVE\|SUPPRESSED\|RESOLVED&severity=&deviceId=&page=&pageSize=`                 |
| POST   | `/api/v1/ingest/alerts`   | 批量导入告警 | body `{source, alerts:[RawAlert]}`；返回 `{accepted, deduped, suppressed, failed, errors}` |
| POST   | `/api/v1/ingest/simulate` | 注入故障剧本 | body `{scenario, seed?, reset?}`；返回 `{alerts, incidentId, correlation}`                 |

`RawAlert` 字段：`deviceName | deviceId`、`type`、`severity`、`message`、`firstSeen`、
`metric?`、`value?`、`threshold?`、`externalKey?`。CSV 导入用 `?format=csv` + `text/csv` 正文。

## 拓扑

| Method | Path               | 说明       | 备注                                                                 |
| ------ | ------------------ | ---------- | -------------------------------------------------------------------- |
| GET    | `/api/v1/topology` | 拓扑图数据 | `{nodes, edges, stats:{devices,links,byLayer}}`，可直接喂 React Flow |

## 事件

| Method | Path                                               | 说明                      | 备注                                                                                                                                    |
| ------ | -------------------------------------------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/v1/incidents`                                | 事件列表                  | `?status=&severity=&queue=&page=&pageSize=`；`queue=UNASSIGNED\|UNANALYZED\|AWAITING_CONFIRM` 即值班队列                                |
| GET    | `/api/v1/incidents/[id]`                           | 事件详情                  | `[id]` 接受 id 或 `INC-YYYYMMDD-NNN`；含 alerts / devices / changes / hypotheses / analysis / statusLog / closure / timeline / topology |
| PATCH  | `/api/v1/incidents/[id]`                           | 状态流转（T08）           | body `{status, note?}`；非法流转 409 `INVALID_TRANSITION`                                                                               |
| POST   | `/api/v1/incidents/[id]/claim`                     | 接手 / 转派（第 3 阶段）  | body `{assignee, team?, note?, force?}`；抢单 409 `ALREADY_CLAIMED`，已结束 409 `INCIDENT_CLOSED`                                       |
| DELETE | `/api/v1/incidents/[id]/claim`                     | 释放回队列                | 保留 `claimedAt`（响应已经发生过，不能洗掉）                                                                                            |
| POST   | `/api/v1/incidents/[id]/split`                     | 事件拆分（人工纠错）      | body `{alertIds:[...], note?}`；见下节                                                                                                  |
| PATCH  | `/api/v1/incidents/[id]/hypotheses/[hypothesisId]` | 采纳 / 否决假设（T08）    | body `{verdict:'ACCEPTED'\|'REJECTED'\|null, note?}`；`null` = 撤销裁决                                                                 |
| POST   | `/api/v1/incidents/[id]/hypotheses/[hid]/verify`   | 勾选验证步骤（第 3 阶段） | body `{stepIndex, done, note?}`；`by` 由服务端从请求身份解析，不接受前端自称                                                            |
| POST   | `/api/v1/incidents/[id]/report`                    | 生成复盘报告（T08）       | 返回 `text/markdown`；`?save=0` 只生成不落库；报告 id 在 `x-report-id` 头                                                               |
| GET    | `/api/v1/incidents/[id]/report`                    | 最近一次报告（T08）       | 返回 `text/markdown`；没生成过则 404                                                                                                    |
| POST   | `/api/v1/incidents/[id]/analyze`                   | AI 研判（T07）            | `?force=1` 或 body `{force:true}` 跳过 5 分钟缓存；同步返回，非 SSE；响应带 `progress`                                                  |
| GET    | `/api/v1/incidents/[id]/analyze/status`            | 研判阶段进度（第 3 阶段） | `{running, progress}`；研判是同步 POST，这里读同进程的阶段表，供前端轮询                                                                |
| POST   | `/api/v1/correlation/run`                          | 手动触发聚合              | body `{now?}`；返回 `{created, updated, reopened, converged, merged}`                                                                   |

值班相关字段（第 3 阶段）：

```jsonc
{
  "assignee": "陈昊", // 责任人；未接手为 null
  "team": "网络组",
  "claimedAt": "2026-11-20T15:14:05.184Z",
  "response": {
    "state": "DUE_SOON", // UNASSIGNED | WITHIN | DUE_SOON | BREACHED | SETTLED
    "slaMinutes": 10, // 创建时的策略快照，不随策略变更追溯
    "remainingSeconds": 121, // 负数 = 已超时秒数
    "claimSeconds": null, // 接手耗时（MTTA）；未接手为 null
    "dueAt": "2026-11-20T15:10:00.000Z",
  },
  "phase": "AWAITING_CONFIRM", // 派生阶段：UNASSIGNED|INVESTIGATING|AWAITING_CONFIRM|LOCATED|MITIGATED|RESOLVED|ARCHIVED
  "services": [
    // 受影响业务 = 事件设备 ∩ 服务依赖设备
    {
      "code": "PAY",
      "name": "支付网关",
      "tier": 1,
      "owner": "李锐",
      "hitDevices": ["CORE-SW-01", "AGG-SW-03"],
      "roles": ["GATEWAY", "TRANSIT"],
    },
  ],
}
```

`phase` 由 `status + assignee + 有无结论 + 有无采纳` 现算，不落库：状态机已经够用，再加一层持久化状态只会让"以谁为准"变成长期争论。

研判进度（`progress`）的形状：

```jsonc
{
  "status": "DONE", // RUNNING | DONE | FAILED
  "stage": "DONE",
  "startedAt": "...",
  "durationMs": 73,
  "stages": [
    { "stage": "CONTEXT", "label": "装配上下文", "durationMs": 43 },
    { "stage": "REASONING", "label": "模型推理", "durationMs": 2 },
    { "stage": "VERIFY", "label": "证据校验", "durationMs": 2 },
    { "stage": "PERSIST", "label": "落库", "durationMs": 26 },
  ],
}
```

事件详情的 `topology` 字段（评审 P0-4）：

```jsonc
{
  "level": "PARTIAL", // FULL | PARTIAL | MISSING
  "deviceCount": 5,
  "linkedDevices": 4,
  "isolatedDevices": [{ "id": "cm...", "name": "AGG-SW-04" }],
  "linkCount": 6,
  "components": 1,
  "maxHops": 3, // 事件设备间最大跳数，>2 视为可能缺链
  "ratio": 0.8,
  "topologyNote": "1 台设备没有链路记录（AGG-SW-04）。结论按候选排序展示，置信度已按完整度下调。",
}
```

`converged` 是二次收敛的结果（同指纹跨告警周期重报，并回未结案的原事件）：

```jsonc
{ "id": "cm...", "code": "INC-20261120-001", "added": 3, "gapMinutes": 40 }
```

### PATCH /api/v1/incidents/[id] — 状态机

只向前、允许跳级；`RESOLVED` 唯一出口是 `CLOSED`，`CLOSED` 为终态。同状态视为幂等（`changed:false`）。

```jsonc
// 成功
{
  "id": "cm...",
  "code": "INC-20261119-001",
  "from": "ANALYZING",
  "to": "RESOLVED",
  "changed": true,
  "mttrSeconds": 818,
  "statusLog": [{ "from": "ANALYZING", "to": "RESOLVED", "at": "...", "note": "更换线卡后恢复" }],
  "reportId": "cm...", // 结案时自动生成
  "caseId": "cm...", // 结案时自动沉淀
  "warnings": [], // 案例/报告生成失败时的提示（状态已生效，不回滚）
}

// 409
{
  "error": {
    "code": "INVALID_TRANSITION",
    "message": "事件不能从已恢复变更为待处理",
    "details": { "from": "RESOLVED", "to": "OPEN", "allowed": ["CLOSED"], "reason": "BACKWARD_OR_UNKNOWN" }
  }
}
```

结案（`to=RESOLVED`）的副作用：写 `resolvedAt / mttrSeconds / closedReason=MANUAL / closure`，
并在事务外沉淀 `CaseRecord` 与 `Report`（失败进 `warnings`，不阻塞结案）。

### POST /api/v1/incidents/[id]/split — 事件拆分

自动聚合判错时的人工纠正入口。选中的告警移到新建事件，原事件重算聚合字段。

```jsonc
// 请求
{ "alertIds": ["cm...", "cm..."], "note": "这两条是换线余波" }

// 200
{
  "source": { "id": "cm...", "code": "INC-20261120-001", "alertCount": 19 },
  "target": { "id": "cm...", "code": "INC-20261120-002", "alertCount": 3 },
  "moved": 3
}
```

约束与语义：

- 至少选 1 条，且**不能把全部告警拆走**（原事件不能变成空壳）→ 400。
- 告警不属于该事件 → 400，且不改动任何数据。
- 已结案（`RESOLVED/CLOSED`）→ 409，需先重开。
- 新事件带 `splitFromId`，聚合的合并阶段会跳过这对组合 —— 人工判断不会被下一轮自动合并推翻。
- 原事件 `statusLog` 追加一条「拆分 N 条告警到 INC-…」，审计表记 `incident.split`。

## 案例

| Method | Path                   | 说明               | 关键参数                                                                     |
| ------ | ---------------------- | ------------------ | ---------------------------------------------------------------------------- |
| GET    | `/api/v1/cases`        | 案例列表 / 检索    | `?q=&tag=&verification=&page=&pageSize=`；`q` 按空格分词后**逐词 AND**       |
| GET    | `/api/v1/cases/search` | 相似案例召回（UI） | `?q=&incidentId=&limit=3`；只给 `incidentId` 时按告警类型/层级召回并排除自身 |
| PATCH  | `/api/v1/cases/[id]`   | 人工确认 / 驳回    | body `{verification:'VERIFIED'\|'REJECTED'\|'UNVERIFIED', note?}`            |

`q` 命中范围：`title / symptom / rootCause / resolution`（不区分大小写）与 `tags`（精确匹配）。

**`verification` 决定召回资格**（评审 P0-3）：

| 值           | 产生方式                           | 是否进入研判上下文 |
| ------------ | ---------------------------------- | ------------------ |
| `VERIFIED`   | 结案时有人工采纳的假设，或人工确认 | 是                 |
| `UNVERIFIED` | 结案时只有系统首选（机器猜测）     | 否                 |
| `REJECTED`   | 人工驳回                           | 否                 |

`UNVERIFIED` 的案例在案例库中照常可查（它是线索，不是结论），但不参与
`buildIncidentContext` 的案例召回 —— 未确认的机器猜测一旦回流，会被下一轮研判
当成"历史经验"引用，错误会自我放大。

## 审计

| Method | Path            | 说明         | 关键参数                                        |
| ------ | --------------- | ------------ | ----------------------------------------------- |
| GET    | `/api/v1/audit` | 操作审计查询 | `?action=&result=OK\|FAIL&limit=30`（上限 200） |

返回 `{ items: [{ at, action, actor, target, result, detail, requestId, ip }], total }`。

写入时机（由 `audited()` 包装路由，成功记 `OK`、失败记 `FAIL` 后原样抛错）：

| action                | 触发端点                                              |
| --------------------- | ----------------------------------------------------- |
| `analyze.run`         | `POST /api/v1/incidents/[id]/analyze`                 |
| `hypothesis.verdict`  | `PATCH /api/v1/incidents/[id]/hypotheses/[hid]`       |
| `incident.transition` | `PATCH /api/v1/incidents/[id]`                        |
| `alert.ingest`        | `POST /api/v1/ingest/alerts`                          |
| `scenario.inject`     | `POST /api/v1/ingest/simulate`                        |
| `correlation.run`     | `POST /api/v1/correlation/run`                        |
| `report.generate`     | `POST /api/v1/incidents/[id]/report`                  |
| `case.verify`         | `PATCH /api/v1/cases/[id]`                            |
| `incident.split`      | `POST /api/v1/incidents/[id]/split`                   |
| `incident.claim`      | `POST /api/v1/incidents/[id]/claim`                   |
| `incident.release`    | `DELETE /api/v1/incidents/[id]/claim`                 |
| `hypothesis.verify`   | `POST /api/v1/incidents/[id]/hypotheses/[hid]/verify` |

`actor` 记 `local` 或 `api-key:…<尾4位>`；**不记请求体**，`detail` 只含路由显式声明的小字段。
审计写入失败只降级成一条 warn 日志，不影响业务结果 —— 宁可少一条记录，不能因为审计挂了就让结案失败。

### POST /api/v1/incidents/[id]/analyze — 返回结构

```jsonc
{
  "incidentId": "cm...",
  "code": "INC-20261119-001",
  "source": "RULE_FALLBACK", // RULE_FALLBACK | LLM
  "model": null, // live 模式为实际模型名，mock 为 "mock"
  "cached": false, // true = 命中 5 分钟缓存，本次没调模型
  "summary": "CORE-SW-01 线卡故障为最可能根因，15 台设备受影响",
  "impactScope": "核心层/接入层/汇聚层共 15 台设备、21 条告警（抑制 0 条）",
  "hypotheses": [
    {
      "cause": "...",
      "category": "HARDWARE", // HARDWARE|CONFIG|LINK|CAPACITY|UPSTREAM|OTHER
      "confidence": 0.6,
      "evidence": [{ "type": "ALERT", "ref": "<真实 id>", "desc": "..." }],
      "verifySteps": ["..."],
      "actions": [{ "action": "...", "risk": "HIGH", "requiresApproval": true }],
    },
  ],
  "missingInfo": ["..."],
  "verify": {
    "dropped": [{ "cause": "...", "reason": "EVIDENCE_NOT_FOUND", "detail": "..." }],
    "stats": { "rawEvidence": 3, "validEvidence": 3, "relevanceRate": 1 },
  },
  "trim": [], // 上下文被裁剪的段落，空表示未触发
  "degradedReason": "未配置 LLM_API_KEY，本次由规则引擎给出结论",
  "analyzedAt": "2026-11-19T15:02:28.177Z",
}
```

行为约定：

- **5 分钟内重复调用返回缓存**（`cached:true`），避免误触重复计费；`force` 强制重算。
- **证据校验后若一条不剩**（AC-20）：`hypotheses: []`、`summary: null`、`missingInfo` 给出原因，
  库里清空旧假设，页面显示"证据不足"空态，不展示编造结论。
- **无 `LLM_API_KEY`**（AC-07）：全链路照常可用，`source=RULE_FALLBACK` 且 `degradedReason` 说明原因。
- **`LLM_MOCK=true`**：用 fixture 假输出跑通链路；fixture 里刻意含一条引用不存在 ID 的假设，
  用于验证 L1 丢弃（响应中会出现在 `verify.dropped`）。

## 评测（非 HTTP）

评测刻意**不暴露 HTTP 端点**：它要清场、注入、聚合、逐事件研判再恢复链路，是有副作用的批处理，
放进 API 迟早会被误调用。入口只有脚本：

```bash
npm run eval -- --set=test    # 8 个留出场景
npm run eval -- --set=dev     # 16 个开发场景
npm run eval -- --set=all
```

产物：`evals/results/{dev,test}.md`（人看的表格）与同名 `.json`（机器可读，含逐场景打分）。
评测走的代码路径与线上完全一致（`ingest → correlation → rca.analyze`），唯一的差别是
`LLM_MOCK` 与环境变量在加载 `lib/env` 之前写入，因此同一份数据在两种模式下可比。
