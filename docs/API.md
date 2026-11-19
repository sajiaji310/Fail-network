# API 契约（NetScope MVP-0）

> 与 `docs/PROJECT-FRAMEWORK.md` 第 9 节一致；本文件只记录**已实现**的端点，未实现的不写。
> 约定：全部 JSON；成功 `200/201`；错误统一 `{ error: { code, message, details? } }`；
> 列表统一 `{ items, total, page, pageSize }`；每个响应都带 `x-trace-id`。

## 关键错误码

| code                    | HTTP | 场景                                              |
| ----------------------- | ---- | ------------------------------------------------- |
| `VALIDATION_FAILED`     | 400  | zod 校验失败，details 带字段路径                  |
| `NOT_FOUND`             | 404  | 资源不存在                                        |
| `INVALID_TRANSITION`    | 409  | 事件状态非法流转（含 AC-08 的 `RESOLVED → OPEN`） |
| `DUPLICATE_FINGERPRINT` | 409  | 唯一键冲突                                        |
| `LLM_UNAVAILABLE`       | 503  | 模型超时且降级也失败                              |
| `INTERNAL`              | 500  | 兜底，日志带 traceId                              |

## 系统

| Method | Path          | 说明     | 备注                                                                       |
| ------ | ------------- | -------- | -------------------------------------------------------------------------- |
| GET    | `/api/health` | 健康检查 | `{status, db:'up'\|'down', llm:'live'\|'mock'\|'fallback', llmModel, ...}` |

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

| Method | Path                                               | 说明                   | 备注                                                                                                                         |
| ------ | -------------------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/v1/incidents`                                | 事件列表               | `?status=&severity=&page=&pageSize=`                                                                                         |
| GET    | `/api/v1/incidents/[id]`                           | 事件详情               | `[id]` 接受 id 或 `INC-YYYYMMDD-NNN`；含 alerts / devices / changes / hypotheses / analysis / statusLog / closure / timeline |
| PATCH  | `/api/v1/incidents/[id]`                           | 状态流转（T08）        | body `{status, note?}`；非法流转 409 `INVALID_TRANSITION`                                                                    |
| PATCH  | `/api/v1/incidents/[id]/hypotheses/[hypothesisId]` | 采纳 / 否决假设（T08） | body `{verdict:'ACCEPTED'\|'REJECTED'\|null, note?}`；`null` = 撤销裁决                                                      |
| POST   | `/api/v1/incidents/[id]/report`                    | 生成复盘报告（T08）    | 返回 `text/markdown`；`?save=0` 只生成不落库；报告 id 在 `x-report-id` 头                                                    |
| GET    | `/api/v1/incidents/[id]/report`                    | 最近一次报告（T08）    | 返回 `text/markdown`；没生成过则 404                                                                                         |
| POST   | `/api/v1/incidents/[id]/analyze`                   | AI 研判（T07）         | `?force=1` 或 body `{force:true}` 跳过 5 分钟缓存；同步返回，非 SSE                                                          |
| POST   | `/api/v1/correlation/run`                          | 手动触发聚合           | body `{now?}`；返回 `{created, updated, reopened, merged}`                                                                   |

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

## 案例

| Method | Path                   | 说明            | 关键参数                                                                     |
| ------ | ---------------------- | --------------- | ---------------------------------------------------------------------------- |
| GET    | `/api/v1/cases`        | 案例列表 / 检索 | `?q=&tag=&page=&pageSize=`；`q` 按空格分词后**逐词 AND**                     |
| GET    | `/api/v1/cases/search` | 相似案例召回    | `?q=&incidentId=&limit=3`；只给 `incidentId` 时按告警类型/层级召回并排除自身 |

`q` 命中范围：`title / symptom / rootCause / resolution`（不区分大小写）与 `tags`（精确匹配）。

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
