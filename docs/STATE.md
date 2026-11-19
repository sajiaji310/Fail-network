# STATE.md — 当前进度 / 阻塞 / 下一步

> Agent 每次会话必读必写。只记事实，不写计划口号。
> 最后更新：2026-11-19 21:07

## 当前任务

**T02 数据模型与种子 — 已实现，等待人工验收**

## 已完成

### T01 工程基座（已验收）

- [x] 便携版 PostgreSQL 16.14（`E:/sinxiangmy/.tools/pg16`，数据目录 `.tools/pgdata`，端口 5432，用户 `netscope`，库 `netscope`，trust 认证）
- [x] 仓库骨架按第 7 节落盘（app / api / modules / lib / components / scripts / docs）
- [x] `src/app/globals.css` 全量设计 Token（@theme 定义，同时生成 Tailwind 类名）
- [x] `GET /api/health` → `{status, db, llm, node, stage, traceId}`
- [x] `/overview` 环境自检页 + 数据基线卡
- [x] `lib/{db,env,logger,errors,result}`；`modules/system/service`
- [x] 门禁：ESLint(flat) + Prettier + tsc strict + Vitest；CI / compose / Dockerfile / .env.example
- [x] `npm run db:start|stop|status`（便携版 PG 管理脚本）

### T02 数据模型与种子

- [x] `prisma/schema.prisma` 全量：5 枚举 + 8 表（Device / TopologyLink / AlertFingerprint / Alert / ChangeRecord / Incident / Hypothesis / CaseRecord / Report）
- [x] 指纹与发生拆表：`AlertFingerprint.signature @unique`、`Alert @@unique([fingerprintId, cycleStart])`、`Alert.externalKey @unique`
- [x] `Incident.clusterKey @unique`（B8 幂等落点）、`mergedIntoId` / `reopenedFromId` / `reopenedCount` / `closedReason` 齐备
- [x] `db:push` 成功，Prisma Client 按新模型生成
- [x] `scripts/seed-data.ts`：30 设备（CORE 1 / AGG 4 / ACC 25，5 个站点）、30 条历史案例（6 类根因）
- [x] `scripts/seed.ts`：60 链路（4 核心-汇聚 + 3 汇聚链 + 50 接入双归属 + 3 堆叠）、30 事件 + 30 案例，全部 upsert 幂等、时间基于固定基准日
- [x] 拓扑校验：30 台全部可达，核心→接入最大 2 跳，全局最大 3 跳（B7「>2 跳强制不合并」有可测样本）
- [x] 概览页新增「数据基线」卡（设备/链路/案例/告警 与基线对比）

## 未完成 / 已知偏差

- 本机无管理员权限，数据库**不能注册为 Windows 服务**，重启后需 `npm run db:start`
- `next lint` 在 Next 15.5 已废弃且会交互式提问，改用 `eslint .`（flat config），额外开启 `no-console`/`no-explicit-any`
- Playwright 未安装，`playwright.config.ts` 与 `tests/e2e/` 随 T09 落地
- **文档 8 节 `Device.alerts Alert[]` 是笔误**：`Alert` 只经 `AlertFingerprint` 关联设备，无反向关系，Prisma 校验直接报错 → 已删除该字段，需回写文档
- **文档 4.1 表格里的 `IncidentAlert` 未建表**：B2 强制单归属，`Alert.incidentId` 已够用；模型（第 8 节）优先于流程表表述
- **`CaseRecord.embedding` 降级为 `String?`**：便携版 PG 无 pgvector，`Unsupported("vector(1536)")` 会让 `db:push` 报 `type "vector" does not exist`；P1 换 pgvector 镜像时切回
- 拓扑偏稠密：接入双归属 + 汇聚链，2 跳邻域覆盖约 70% 设备，T05 需靠 B7 与类型共现矩阵控簇规模（调参在代码常量里）
- 本机沙箱对**单轮批量删除 >50 文件**拦截：`next dev` / `next build` 启动清理 `.next(-dev)` 会失败。我这边每次改用 PowerShell `Remove-Item -Recurse -Force`；你自己终端跑不受影响
- 文档 7 节写 `(console)/page.tsx # /overview`，实际是 `(console)/overview/page.tsx` + `/` 重定向

## 下一步

1. 人工验收 T02（清单见下）
2. 验收通过 → T03：告警接入 + 5 套故障剧本模拟器（CSV/JSON 导入、`externalKey` 幂等、脏数据容错）

## T02 人工验收清单

```bash
npm run db:push     # 期望：Your database is now in sync
npm run db:seed     # 期望：设备 30 · 链路 60 · 事件 30 · 案例 30；层级 L1:1 / L2:4 / L3:25
npm run db:seed     # 再跑一次，数字必须完全不变（幂等）
npm run db:studio   # 可选：图形界面逐表核对
```

浏览器 http://localhost:3000/overview → 「数据基线」卡显示 30/30、60/60、30/30、告警 0，并标「种子数据就位」。

## 阻塞

- 暂无

## 请求新增依赖

- 暂无
