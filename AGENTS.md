# AGENTS.md

## 项目

NetScope — 网络故障智能研判平台。唯一事实源：`docs/PROJECT-FRAMEWORK.md`。
任何与文档冲突的实现，以文档为准；文档确实有误时，先改文档再改代码。

## 每次开始前

1. 读 `docs/STATE.md` 的「当前任务」与「阻塞」
2. 读本次任务卡（`docs/AGENT-TASKS.md` 中对应 Txx）
3. 只改任务卡声明的文件范围

## 铁律

- 分层：`app/api` → `modules` → `lib`，禁止反向依赖，禁止跨模块 import repository
- 单文件 ≤ 300 行，`page.tsx` ≤ 120 行
- 图标只用 `lucide-react`，禁止 emoji 作图标，禁止引入第二套 UI 库
- 颜色只用 `src/app/globals.css` 中的 CSS 变量，禁止硬编码（#fff/#000 除外）
- 禁止 `any`；外部输入用 `unknown` + zod 收窄
- 不新增依赖：需新增时先在 `docs/STATE.md` 记「请求新增依赖：xxx，理由」，等确认
- 数据库改动必须同时提供 migration 与 seed 兼容说明
- 改 API 必须同步更新 `docs/API.md`

## 每次结束前（缺一不可）

```bash
npm run lint && npm run typecheck && npm run test
```

然后更新 `docs/STATE.md`：已完成 / 未完成 / 下一步 / 新发现的坑。

## 失败处理

同一问题连续 3 次修复失败 → 停止，写进 `STATE.md` 的「阻塞」，不要继续瞎改。

## 人工验收闸门

本项目每个任务卡结束都必须停下来等人手验（跑命令 + 看页面 + 确认结果），
未获确认不得进入下一张卡。
