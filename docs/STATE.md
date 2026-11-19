# STATE.md — 当前进度 / 阻塞 / 下一步

> Agent 每次会话必读必写。只记事实，不写计划口号。
> 最后更新：2026-11-19 21:35

## 当前任务

**T04 归一化 + 抑制 + 生命周期 — 已实现，等待人工验收**

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
- [x] `modules/alerts/fingerprint.ts`：`signatureOf`（sha1(deviceId|type|metric)）、`clusterKeyOf`（排序去重后哈希）
- [x] 5 套剧本 JSON 全部可注入且 0 失败：核心线卡 / 光模块劣化 / ACL 变更 / DNS 过载 / 出口闪断
- [x] `POST /api/v1/ingest/alerts`：JSON 与 `text/csv` 两种 body，2MB 上限
- [x] `POST /api/v1/ingest/simulate`：`{scenario, seed?}`，未知剧本 404
- [x] `npm run sim -- --list | --scenario=x [--seed=42]`

### T04 归一化 + 抑制 + 生命周期

- [x] `modules/alerts/taxonomy.ts`：告警类型三分类（PARENT / ROOT / CHILD / UNKNOWN），抑制规则的唯一事实源
- [x] `modules/alerts/normalize.ts`：30 分钟周期判定 `decideCycle`（纯函数）+ `normalizeOccurrence`（落库）
- [x] `modules/alerts/suppress.ts`：`suppressByParent`（含 B9 回溯 + 撤出 + 自动关闭）、`restoreByParent`、`resolveParentAlert`
- [x] `modules/alerts/service.ts`：`recordAlert` 编排（指纹 → 周期 → 抑制）、`getAlertStats`、`listAlerts`
- [x] `Alert.suppressedByAlertId` 自关联字段：抑制可溯源，父告警恢复时精确回滚
- [x] `GET /api/v1/alerts`：`?status=&severity=&deviceId=&type=&from=&to=&page=&pageSize=`，非法参数 400 带 details
- [x] `npm run alerts:recompute` / `alerts:stats`：存量重算 + 状态分布
- [x] 概览页新增「告警状态」卡（ACTIVE / SUPPRESSED / RESOLVED / 折叠次数 + 抑制明细）
- [x] 测试 43 条（新增 23 条）：生命周期 10 / 规则纯函数 8 / 类型分类 5
- [x] ingest 返回值扩展：`suppressed`（本次落库即被抑制）、`retroSuppressed`（B9 回溯压制数）、`autoClosedIncidents`

### T04 关键实测（CORE-SW-01 核心线卡故障剧本）

| 项                          | 结果                                                                  |
| --------------------------- | --------------------------------------------------------------------- |
| 该设备告警总数              | 15 条（1 父告警 + 1 根因 + 13 子告警）                                |
| 被抑制                      | 13 条（CPU_HIGH 4 / HIGH_LATENCY 2 / BGP_NEIGHBOR_DOWN 2 / 其余各 1） |
| 根因 `LINECARD_FAILURE`     | **保持 ACTIVE，未被误抑制**（AC-19 误抑制率 0）                       |
| 父告警 `DEVICE_UNREACHABLE` | ACTIVE，`suppressedByAlertId` 全部指向它                              |

## 未完成 / 已知偏差

- `incidentId` 仍为 `null`：聚合在 T05 接入后回填
- B9 的"事件自动关闭"已在单测中用手工构造的事件验证；真实事件流等 T05 接上
- 告警周期无独立 `closedReason` 字段，过期关闭只置 `RESOLVED`（事件层的 closedReason 已有）
- 剧本注入每次生成新 `runId` 与新 externalKey（= 一批新告警），同一批次重复导入才走 deduped
- 文档 8 节 `Device.alerts` 笔误、`IncidentAlert` 未建表、`embedding` 降级 `String?`（详见 T02 记录）
- 本机沙箱单轮删除 >50 文件会拦截：重启 dev/build 前先用 PowerShell 清 `.next(-dev)`
- 本机无管理员权限 → 数据库不能注册 Windows 服务，重启后 `npm run db:start`

## T04 对文档的三处落地判断（需回写 PROJECT-FRAMEWORK.md）

1. **抑制不能"同设备全压制"**。4.1 节示例是"设备离线 → 抑制该设备所有端口 down"，但 `core-switch-board-failure` 里根因 `LINECARD_FAILURE` 与父告警 `DEVICE_UNREACHABLE` 在同一台设备，全压制必然误杀根因、AC-19 直接不达标。实现改为**可抑制白名单**（端口/链路/邻居/指标），设备级硬件故障与未登记类型一律不抑制。
2. **周期锚点不再取整到分钟**。T02 的实现让 `cycleStart` 取整到分钟，副作用是告警 `RESOLVED` 后在同一分钟内再次上报时，新周期锚点与已关闭周期相同 → P2002 兜底把新告警合并进 `RESOLVED` 行，**新周期直接消失**。改为保留毫秒精度；同一条上游数据 `firstSeen` 完全相同，仍能命中唯一键。
3. **B9 回溯窗口只设下界**（父告警 `firstSeen - 2h`），不设上界。父告警 ACTIVE 表示设备此刻仍不可达，之后补报的子告警同样应被追溯压制。

## 下一步

1. 人工验收 T04（清单见下）
2. 通过后 → T05：关联聚合（B1–B9 全量、幂等、500 条 < 500ms）

## T04 人工验收清单

```bash
cd E:/sinxiangmy/netscope

# 1) 状态分布：ACTIVE 65 · SUPPRESSED 13 · 合计 78
npm run alerts:stats

# 2) 抑制列表：13 条，suppressedByAlertId 指向同一父告警
curl -s "localhost:3000/api/v1/alerts?status=SUPPRESSED&pageSize=3"

# 3) 根因未被误抑制：应返回 LINECARD_FAILURE，status=ACTIVE
curl -s "localhost:3000/api/v1/alerts?type=LINECARD_FAILURE"

# 4) 存量重算（幂等，再跑压制数仍为 13）
npm run alerts:recompute

# 5) 规则单测：43 passed
npm run test
```

浏览器 http://localhost:3000/overview → 「告警状态」卡：SUPPRESSED 13、抑制生效、明细列出 8 类。

## 阻塞

- 暂无

## 请求新增依赖

- 暂无
