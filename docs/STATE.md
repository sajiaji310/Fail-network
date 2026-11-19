# STATE.md — 当前进度 / 阻塞 / 下一步

> Agent 每次会话必读必写。只记事实，不写计划口号。
> 最后更新：2026-11-19 20:35

## 当前任务

**T01 工程基座 — 已实现，等待人工验收**

## 已完成

- [x] 便携版 PostgreSQL 16.14（`E:/sinxiangmy/.tools/pg16`，数据目录 `.tools/pgdata`，端口 5432，用户 `netscope`，库 `netscope`，trust 认证）
- [x] 仓库骨架按第 7 节落盘（app / api / modules / lib / components / scripts / docs）
- [x] `src/app/globals.css` 全量设计 Token（@theme 定义，同时生成 Tailwind 类名）
- [x] `GET /api/health` → `{status, db, llm, node, stage, traceId}`，DB 探活走 `SELECT version()`
- [x] `/overview` 环境自检页（4 张状态卡 + 验收命令 + 任务卡进度）
- [x] `lib/{db,env,logger,errors,result}` 基础层就位；`modules/system/service` 首个领域服务
- [x] 门禁：ESLint(flat) + Prettier + tsc strict + Vitest（含 3 条 result 用例）
- [x] CI（`.github/workflows/ci.yml`）、`docker-compose.yml`、`Dockerfile`、`.env.example`
- [x] `npm run db:start|stop|status`（便携版 PG 管理脚本）

## 未完成 / 已知偏差

- 本机无管理员权限，数据库**不能注册为 Windows 服务**，会话结束/重启后需 `npm run db:start`
- `next lint` 在 Next 15.5 已废弃且会交互式提问，改用 `eslint .`（flat config），规则等价并额外开启 `no-console`/`no-explicit-any`
- Playwright 未安装（避免 T01 下载 300MB 浏览器），`playwright.config.ts` 与 `tests/e2e/` 随 T09 落地
- `prisma/schema.prisma` 目前只有 datasource/generator，全量模型在 T02
- pgvector 扩展未安装（便携版 PG 无此扩展），T02 时 `CaseRecord.embedding` 的 `Unsupported("vector(1536)")` 需降级为可空文本字段，等有 pgvector 环境再切回
- 文档 7 节写 `(console)/page.tsx # /overview`，实际实现为 `(console)/overview/page.tsx` + `/` 重定向，与 11.1 页面清单一致

## 下一步

1. 人工验收 T01（清单见下）
2. 验收通过 → T02：Prisma 全量模型 + seed（30 设备 / 60 链路 / 30 案例）

## T01 人工验收清单

```bash
npm run db:status                  # 期望：accepting connections
curl -s localhost:3000/api/health  # 期望：HTTP 200，db:"up"
npm run lint && npm run typecheck && npm run test
npm run build
```

浏览器打开 http://localhost:3000 → 应重定向到 `/overview`，四张卡片状态正常、顶栏 DB 已连接。

## 阻塞

- 暂无

## 请求新增依赖

- 暂无
