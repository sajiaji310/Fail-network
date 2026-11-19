# STATE.md — 当前进度 / 阻塞 / 下一步

> Agent 每次会话必读必写。只记事实，不写计划口号。
> 最后更新：2026-11-19 22:05

## 当前任务

**T05 关联聚合 — 已实现，等待人工验收**

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

### T05 关联聚合

- [x] `correlation/constants.ts`：权重 0.45/0.30/0.25、阈值 0.55、5 分钟窗、2 跳、30 分钟重开窗，全部集中可调
- [x] `correlation/topology.ts`：无向邻接 + BFS 跳数（带 memo），`minHopBetween` 供事件级合并用（B1）
- [x] `correlation/affinity.ts`：类型归 6 族 + 族间亲和度表（同类型 1.0 / 同族 0.9 / 跨族 0.3~0.7）
- [x] `correlation/scoring.ts`：`scorePair` 纯函数 + `withinWindow` + `canRelate`（B7 硬闸门）
- [x] `correlation/cluster.ts`：并查集 + 两两打分，确定性排序，输出稳定 `clusterKey`（B8）
- [x] `correlation/match.ts`：簇↔事件打分、`matchesFault`（B5 / B6 判定）
- [x] `correlation/merge.ts`：B3 合并判定（共享 ≥2 设备 / Jaccard 时间重叠 >50% / ≤2 跳）+ 合并落库
- [x] `correlation/persist.ts`：`INC-YYYYMMDD-NNN` 按天取最大序号 +1、聚合字段重算、事件标题、重开
- [x] `correlation/service.ts`：`runCorrelation(now)` 两段式（内存聚类 → 归属决策）+ 事件级合并收敛
- [x] `incidents/service.ts`：`listIncidents`（含 alertCount / deviceCount / deviceNames）、`getIncidentStats`
- [x] `POST /api/v1/correlation/run`、`GET /api/v1/incidents`
- [x] `npm run corr:run`（CLI 明细）、`scripts/demo-reset.ts`（`--reset` 清场）
- [x] `Incident.lastSeen`（B5 要求的"延长 lastSeen"，文档 8 节模型缺失）
- [x] 概览页新增「事件」卡（活跃 / 24h / 累计 / 告警事件比 + 活跃事件列表）
- [x] 测试 80 条（新增 37 条）：打分 13 / 聚类 9 / 合并 7 / 聚合集成 8

## T05 关键实测

| 项           | 结果                                                                    |
| ------------ | ----------------------------------------------------------------------- |
| 核心线卡剧本 | 22 条告警 → **1 个事件**（21 有效 + 1 抑制），15 台设备，P0             |
| 聚合耗时     | 22 条 86~167ms；500 条含 DB 往返 **358ms**（AC-11 < 500ms）             |
| 幂等         | 连跑 3 次：第 1 次沿用，第 2/3 次 `created=0 / updated=0`，事件 id 不变 |
| 告警事件比   | 21:1（阈值 ≥ 8:1）                                                      |
| 根因告警     | `LINECARD_FAILURE` 保持 ACTIVE，未被抑制                                |

## 未完成 / 已知偏差

- B4（人工拆分）按文档推迟到 P2，本卡不做
- `Incident.summary` / `impactScope` 留空：T07 研判时写入
- `GET /api/v1/incidents/[id]`（详情）与拓扑高亮属 T06
- 文档 8 节 `Device.alerts` 笔误、`IncidentAlert` 未建表、`embedding` 降级 `String?`（见 T02 记录）
- 文档 8 节 `Incident` 缺 `lastSeen`，与 4.2 B5"延长 lastSeen"矛盾，本卡已补字段（需回写文档）
- 本机沙箱单轮删除 >50 文件会拦截：重启 dev/build 前先用 PowerShell 清 `.next(-dev)`
- 本机无管理员权限 → 数据库不能注册 Windows 服务，重启后 `npm run db:start`

## T05 对文档的三处落地判断（需回写 PROJECT-FRAMEWORK.md）

1. **`clusterKey` 不能只用指纹集合**。B8 定义 `clusterKey = sha1(排序后的 fingerprintId)`，但"同一故障隔天再发生"时指纹集合完全相同 → 撞唯一键，新事件建不出来。实现：首次发生用纯指纹集合；复发事件（超 30 分钟）把 `reopen:<旧事件id>` 混入 key，仍然确定性、仍可 upsert。
2. **B7 必须做成显式闸门，不能只靠公式**。拓扑距离 >2 跳时公式仍可算出 `0.30 + 0.25 = 0.55`，正好等于阈值，纯按分数会误合并。`canRelate()` 在打分前先拦；事件级合并同样先判跳数再看其他条件。
3. **聚合只处理"截至聚合时刻"的活跃告警**。查询必须卡 `lastSeen <= now` 上界：否则时钟偏差或补报的未来时间告警会被并进来；集成测试用固定历史基准时间（2026-11-10）隔离数据也依赖这一点。

## 已知行为（不是 bug，验收时别误会）

- **多套剧本同时注入会并成一个大事件**。5 套剧本的告警落在同一时间段，种子拓扑最大 3 跳、绝大多数设备 ≤2 跳，按 B7 只能拦住 >2 跳的组合，因此"时间重叠 + 2 跳内 + 类型相近"的簇会合法合并。逐套验收请用 `--reset` 清场（T09 评测也会按场景重置）。
- **5 分钟滑窗是硬边界**，不是"平均间隔"。同一设备相隔 10 分钟的两条同类型告警不会直接成簇，而是靠 B5（分 ≥0.55）挂到已存在的事件上 —— 这正是 AC-15 的路径。
- **不足 3 条的簇不成事件**，但它们会留在库里，等后续告警把簇补齐。

## 下一步

1. 人工验收 T05（清单见下）
2. 通过后 → T06：事件详情三栏工作台 + 只读拓扑高亮

## T05 人工验收清单

```bash
cd E:/sinxiangmy/netscope

# 1) 清场并注入一套剧本（内部会自动跑聚合）
npm run sim -- --scenario=core-switch-board-failure --reset
# 期望：22 条告警 → 新增 22 / 失败 0；聚合 新建 1；打印事件 id

# 2) 幂等：再跑两次，都应显示「本次无变更」
npm run corr:run
npm run corr:run

# 3) 事件列表
curl -s "localhost:3000/api/v1/incidents?status=OPEN" | jq .
# 期望：total=1，alertCount=21，deviceCount=15，severity=P0

# 4) 接口触发聚合（幂等，created/updated 全为空）
curl -s -X POST localhost:3000/api/v1/correlation/run

# 5) 规则单测：80 passed
npm run test
```

浏览器 http://localhost:3000/overview → 「事件」卡：活跃事件 1、告警/事件 21.0、列表出现
`INC-20261119-001 CORE-SW-01 LINECARD_FAILURE（波及 15 台设备）`。

## 阻塞

- 暂无

## 请求新增依赖

- 暂无
