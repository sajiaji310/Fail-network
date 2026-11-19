# NetScope 网络故障智能研判平台 — 项目框架总纲

> 版本：v0.2（吸收 2026-11-19 外部评审后的修订版）
> 日期：2026-11-19
> 修订要点：P0 收缩为可验证的纵向切片、告警生命周期模型拆分（指纹 / 发生周期）、补齐事件边界规则、评测集扩容并留出 held-out、纠正"反幻觉"表述。逐条响应见第 21 节。
> 定位：单人 + AI Agent 协作开发的 MVP 工程基线。这份文档是仓库的唯一事实源（Single Source of Truth），所有 Agent 会话、所有代码改动都以本文档为准。
> 状态：DRAFT → 你确认后转 LOCKED，改动走第 20 节变更记录。

---

## 0. 怎么读这份文档

| 你是谁 / 你要做什么 | 读哪几节 |
|---|---|
| 第一次跑起来 | 0.1 快速开始 → 7 目录结构 → 16 部署 |
| 写业务代码 | 2 范围 → 8 数据模型 → 9 API → 13 工程规范 |
| 交给 AI Agent 干活 | 14 Agentic Coding 手册（重点） → 7 目录 → 13 规范 |
| 面试/写 README 讲故事 | 1 项目定义 → 4 业务流程 → 10 AI 层设计 |
| 判断做完了没有 | 19 验收标准 → 15 测试门禁 |

### 0.1 快速开始（目标：5 分钟内跑通）

```bash
git clone https://github.com/<you>/netscope.git && cd netscope
cp .env.example .env          # 填 DATABASE_URL；LLM key 可不填，自动降级规则引擎
docker compose up -d db
npm install
npm run db:push && npm run db:seed
npm run sim -- --scenario=core-switch-board-failure   # 注入一套故障剧本
npm run dev                   # http://localhost:3000
```

无 LLM Key 时全站可用（AI 研判走规则降级），这是刻意设计：先保证 demo 在任何机器上能跑，再谈智能。

---

## 1. 项目定义

**一句话**：把"一堆告警"变成"一个结论"——自动聚合告警、定位根因、给出证据链与处置建议，并在结案后沉淀为可复用的故障案例。

**要解决的问题**（真实运维痛点，非臆造）：
- 一次核心设备故障会引发几十上百条衍生告警，值班人员看到的是告警风暴，不是故障本身。
- 根因判断高度依赖老员工经验，新人只能按"重启/换线/上报"三件套试错。
- 故障处置完就结束了，经验不沉淀，同类故障下次照样从零排查。

**目标用户**：
- 一线运维值班工程师（需要快速知道"先看哪里"）
- 运维组长 / SRE（需要 MTTR 数据与复盘材料）

**核心价值主张**（全部可测，不用形容词）：
- **告警压缩比**：5 套固定剧本上，`原始告警数 / 生成事件数 ≥ 8:1`，且标注为根因的关键告警零误抑制。
- **根因可定位**：Top3 命中率 ≥ 80%，Top1 ≥ 50%（在 held-out 测试集上，非训练集）。
- **结论可审计**：每条假设至少挂 1 条真实存在的证据 ID，且证据指向的设备必须落在事件影响范围内。

**差异化（写进 README 的钩子）**：不是又一个告警看板，而是**证据驱动的根因推理**——AI 输出的每个根因假设必须挂上真实存在的 alertId / changeId / 拓扑路径，校验不过的假设直接丢弃。这能减少无依据输出、提升结果可审计性；但它**不等于**判断一定正确，根因正确性只由评测集和人工接受率来证明。

---

## 2. 范围锁定

### 2.1 MVP-0 纵向切片（P0，唯一目标：把闭环跑通）

第一版只证明一件事——**告警能变成有证据的结论**。以下 7 项缺一不可，其余全部后置。

| 编号 | 功能 | 验收锚点 |
|---|---|---|
| F1 | 固定拓扑种子数据 | 30 设备 / 60 链路由 seed 生成，页面只读展示 |
| F2 | 告警接入 | CSV/JSON 导入 + 5 套故障剧本模拟器 |
| F3 | 归一化 + 抑制 + 生命周期 | 指纹去重、父子抑制、结案后重开规则（见 4.3） |
| F4 | 关联聚合 | 时间窗 + 拓扑邻接 → Incident，含合并/拆分/跨窗规则（见 4.2） |
| F5 | 事件详情 | 事件信息 + 关联告警列表 + 拓扑影响设备高亮（只读） |
| F6 | 根因研判 | 规则引擎出候选 → LLM 结构化增强 → 证据校验（双通道） |
| F7 | 人工确认与结案 | 状态流转 + 采纳/否决某条假设 + 结案记录 |

### 2.2 增量阶段（P1，MVP-0 验收后再做，接口预留）

| 功能 | 为什么后置 | MVP-0 如何预留 |
|---|---|---|
| 拓扑编辑（拖拽/CRUD/布局持久化） | 编辑体验打磨成本高，对验证核心价值无贡献 | 数据表与 API 已在，页面先只读 |
| SSE 流式研判 | 体验优化，不影响结论正确性 | 接口按 SSE 设计，MVP-0 用轮询 |
| 案例相似推荐 | 需要足够结案数据才有意义 | 表结构在，先只做关键词检索 |
| 复杂报告模板 | 报告只需固定四段：MTTR/影响面/根因/改进项 | Markdown 固定模板 |
| 通知渠道 | 单人 MVP 无接收方 | 站内列表 |
| 语义检索（pgvector） | 案例 < 1000 时收益不明显 | 字段预埋不启用 |
| 指标体系下钻 | 概览卡片够用 | - |

### 2.3 明确不做（Out of Scope，写在 Spec 里防止范围蔓延）

| 不做 | 原因 | 何时考虑 |
|---|---|---|
| SNMP / NetFlow / Syslog 真实采集 | 需要设备环境与协议栈，MVP 阶段 ROI 极低 | v1.0 若有真实环境 |
| SDN 控制器 / 网管系统对接 | 厂商私有接口，无法通用 | 商业版按客户适配 |
| 自动执行变更/修复 | 生产安全红线，MVP 只给建议不执行 | 永不自动化执行，只做工单联动 |
| 多租户 / RBAC | 单人 MVP 无此需求 | 商业化时 |
| 移动端 | 值班场景有需求但成本高 | v1.2 |
| 自研时序数据库 | 不自造轮子 | 不涉及 |

---

## 3. 关键用户故事

1. 值班工程师小李 02:13 收到 87 条告警。打开概览页，看到 1 个 P0 事件，标题"核心交换机 SW-CORE-01 板卡异常（影响 32 台 AP）"。点进去，拓扑上红色高亮的正是那台交换机，AI 面板给出 3 个根因假设，第一条"电源模块 PS-2 掉电（置信度 0.82）"，证据是 3 条 alertId 和 1 条 23:50 的巡检变更记录。他直接照着处置步骤走。
2. 组长周会需要复盘。在事件详情点"生成复盘报告"，得到 MTTR 42 分钟、影响 32 个接入点、根因、3 条改进项，复制进周报。
3. 两周后又出现类似丢包。MVP-0 阶段能在案例库用关键词翻到上次记录；P1 接入自动召回后，研判时会把"光模块劣化"直接排到 Top1 并引用上次处置步骤。

---

## 4. 核心业务流程

```mermaid
flowchart LR
  A[告警/变更/拓扑数据] --> B[归一化 指纹去重]
  B --> C[关联聚合 时间+拓扑+类型]
  C --> D[故障事件 Incident]
  D --> E[上下文组装]
  E --> F[LLM 根因推理 结构化输出]
  F --> G[证据校验器 幻觉拦截]
  G --> H[Top3 假设 + 处置建议]
  H --> I[人工确认 状态流转]
  I --> J[复盘报告]
  J --> K[案例入库 供下次检索]
  K -.-> E
```

七步拆解：

| 步 | 输入 | 处理 | 输出 | 实现位置 |
|---|---|---|---|---|
| 1 归一化 | 原始告警 | 计算 fingerprint，相同则 count+1、更新 lastSeen | 去重后的 Alert | `modules/alerts/normalize.ts` |
| 2 抑制 | Alert 集合 | 父告警（如设备离线）命中时抑制子告警（如该设备上所有端口 down） | 有效告警集 | `modules/alerts/suppress.ts` |
| 3 聚合 | 有效告警 | 5 分钟滑窗 + 拓扑 2 跳邻接 + 类型共现打分，超阈值成簇 | Incident + IncidentAlert | `modules/correlation/cluster.ts` |
| 4 组装上下文 | Incident | 拉取告警 Top20、拓扑 2 跳、设备指标、24h 变更、Top3 相似案例 | IncidentContext | `modules/rca/context.ts` |
| 5 推理 | IncidentContext | LLM + JSON Schema 输出假设 | Hypothesis[] | `modules/rca/analyze.ts` |
| 6 校验 | Hypothesis[] | 证据引用必须命中真实 ID；否则丢弃并记录 `dropped_by_verifier` | 有效 Hypothesis[] | `modules/rca/verify.ts` |
| 7 沉淀 | 已结案 Incident | 生成报告 + 案例条目 | Report / CaseRecord | `modules/report/*` |

聚合打分公式（可解释、可调参，写在代码常量里）：

```
score(a, b) = 0.45 * topologyProximity(a, b)   // 同设备 1.0 / 直连 0.8 / 2跳 0.5 / 其他 0
            + 0.30 * timeProximity(a, b)       // 1 - |Δt| / window
            + 0.25 * typeAffinity(a.type, b.type)  // 预置共现矩阵
阈值 0.55 成簇，簇内 >= 3 条告警才生成 Incident（防噪声）
```

### 4.2 事件边界规则（比公式更重要，必须按此实现）

评审说得对：聚合真正的难点是"事件边界"，不是打分。以下 8 条为强制约定，缺一条就会出现事件重复或错误合并。

| # | 问题 | 规则 |
|---|---|---|
| B1 | 关系图有向还是无向 | **聚合用无向邻接**（链路两端互相影响）；**根因排序用层级有向 + 时间先后**（下游故障不能推出上游故障，后发生的变更不能解释先发生的告警） |
| B2 | 一条告警能属于几个事件 | **严格单归属**。`Alert.incidentId` 唯一，候选簇冲突时取分最高者；两簇分差 < 0.05 时直接合并（同一故障被拆成两个事件比合并错误更伤体验） |
| B3 | 事件如何合并 | 两事件共享 ≥ 2 台设备、时间重叠 > 50%、拓扑距离 ≤ 2 跳 → 合并；保留 code 较早者，被并入者状态置 CLOSED 并写 `mergedIntoId` |
| B4 | 事件如何拆分 | **MVP-0 不做自动拆分**（误拆代价高）。提供人工"从此告警拆出"操作入口，P2 实现 |
| B5 | 故障跨 5 分钟窗口 | 新告警若与某个 OPEN/ANALYZING/LOCATED 事件的任一告警关联分 ≥ 0.55 → **沿用该事件**，延长 `lastSeen`，不新建 |
| B6 | 结案后再次发生 | RESOLVED 后 30 分钟内同簇再现 → **重新打开**原事件（`reopenedCount+1`）；超过 30 分钟 → 新建事件，`reopenedFromId` 指向旧事件 |
| B7 | 两个故障同时发生 | 两簇拓扑距离 > 2 跳时**强制不合并**，即使时间窗完全重叠；距离 ≤ 2 跳才走 B3 合并判定 |
| B8 | 重复运行聚合 | 事件以 `clusterKey = sha1(排序后的 fingerprintId 列表)` 唯一，聚合做 upsert；同一批数据重复跑结果必须完全一致（幂等），单测强制覆盖 |

**父告警晚到（B9，容易漏）**：子告警先到时允许成事件；父告警（如设备离线）到达后回溯重算最近 2 小时窗口，被抑制的子告警从事件中移除，若事件剩余告警 < 3 条则自动关闭并标记 `AUTO_CLOSED`。

### 4.3 告警生命周期（解决"同一故障隔天再发生"的语义问题）

```
上报 ──► 存在同 fingerprint 的 ACTIVE 告警？
          ├─ 是，且 lastSeen 距今 < 30min ──► count+1、更新 lastSeen（同一次故障）
          ├─ 是，但距今 ≥ 30min ──────────► 关闭旧周期，新建发生（可能重开事件，见 B6）
          └─ 否 ─────────────────────────► 新建发生（新周期）

状态：ACTIVE ──(父告警抑制)──► SUPPRESSED ──(父恢复)──► ACTIVE
      ACTIVE ──(设备恢复/人工确认)──► RESOLVED（终态，不再变更）
```

硬约定：`firstSeen / lastSeen` 只描述**当前这一个告警周期**，绝不跨周期复用。历史查询靠事件与案例，不靠 Alert 行。

---

## 5. 技术选型

### 5.1 选型对比（为什么是它）

| 方案 | 优势 | 劣势 | 结论 |
|---|---|---|---|
| A. Next.js 15 全栈（Route Handlers 作 BFF） | 类型贯通、单进程部署、AI 调用无跨服务开销、单人维护成本最低 | 重计算/长任务不友好 | **采用** |
| B. FastAPI + React 分离 | Python 生态利于数据处理、AI 相关库多 | 双仓库/双部署/类型不同步，MVP 阶段纯增负担 | 备选，见 5.4 演进 |
| C. NestJS + React | 分层规范强、适合多人 | 模板代码多，单人开发速度慢 | 不采用 |

关键判断：本项目的"智能"是**调用式**（一次研判一次 LLM 调用，秒级），不是训练/批量计算，Python 的优势用不上；而全链路 TypeScript 能把 Prisma 类型直接送到前端表格，省掉一整层 DTO 手写。

### 5.2 技术栈锁定（版本锚定，安装后回填实际版本）

| 层 | 技术 | 版本 | 选型理由 |
|---|---|---|---|
| 运行时 | Node.js | 22 LTS | Next 15 推荐，原生 fetch |
| 框架 | Next.js（App Router） | ^15.5 | RSC + Route Handlers 一体 |
| 语言 | TypeScript | ^5.9 | strict 模式 |
| 样式 | Tailwind CSS | ^4.1 | 无 config 文件，CSS-first |
| 组件 | shadcn/ui（复制式，非依赖） | latest | 代码归自己，可改 |
| 图标 | **Lucide React（全项目唯一图标库）** | ^0.540 | 统一描边、可缩放，禁止 emoji 作图标 |
| 图表 | Recharts | ^2.15 | 声明式，够用 |
| 拓扑画布 | @xyflow/react（React Flow） | ^12.8 | 拖拽/连线/自定义节点成熟 |
| 服务端状态 | TanStack Query | ^5.85 | 缓存/重试/失效 |
| 客户端状态 | Zustand | ^5.0 | 仅存 UI 态（筛选/面板开关） |
| 校验 | Zod | ^3.25 | 同一 schema 复用于表单、API、LLM 输出 |
| ORM | Prisma | ^6.14 | 类型安全，migrate 简单 |
| 数据库 | PostgreSQL | 16（pgvector 镜像预埋） | JSONB 存原始报文，未来向量检索 |
| LLM SDK | openai（兼容协议） | ^5.12 | 统一接 DeepSeek / Qwen / OpenAI |
| 日志 | pino | ^9.9 | 结构化 JSON，便于排查 |
| 测试 | Vitest + Playwright | ^3.2 / ^1.55 | 单测快、E2E 真 |
| 部署 | Docker Compose | - | app + db 一键起 |

> 铁律：**锁一套，不混用**。图标只用 Lucide；组件只用 shadcn/ui；不允许再引入 Ant Design / MUI / Chakra。

### 5.3 ADR 摘要

- **ADR-001 采用 Next.js 全栈而非前后端分离**：MVP 单人为交付主体，跨服务调试成本 > 架构收益。后果：长任务需迁出（见 5.4）。
- **ADR-002 不引入向量库**：案例量 < 1000 时，`类型过滤 + 关键词 + LLM 精排` 的召回质量已足够，省一个基础设施与 embedding 成本。后果：案例 > 5000 时需迁 pgvector（字段已预埋 `embedding`）。
- **ADR-003 LLM 输出必须过证据校验器**：宁可少给一个假设，不可给无证据的假设。后果：部分场景会返回"证据不足"，需前端友好提示。

### 5.4 演进路径（写进 README 的 Roadmap，不是现在做）

```
v0.1 单体 Next.js ──► v0.5 抽出 Python Worker（告警规则引擎/时序分析）──► v1.0 消息队列 + 多租户
                          通信方式：Postgres LISTEN/NOTIFY 或 BullMQ
```

---

## 6. 系统架构（分层）

```
┌──────────────────────────────────────────────────┐
│ 表现层  src/app/**  (RSC + Client Components)     │  只装配，零业务逻辑
│         src/components/**  (ui / domain)          │
├──────────────────────────────────────────────────┤
│ 接口层  src/app/api/v1/**/route.ts                │  只做：解析→校验→调 service→映射错误
├──────────────────────────────────────────────────┤
│ 领域层  src/modules/{ingest,alerts,correlation,   │  业务规则唯一归属地
│         incidents,rca,topology,report,case}/      │  可被单测直接调用
│         ├ service.ts  业务编排                    │
│         ├ repository.ts 数据访问（只碰 prisma）    │
│         ├ schema.ts   zod 契约                    │
│         └ *.test.ts                               │
├──────────────────────────────────────────────────┤
│ 基础层  src/lib/{db,llm,logger,errors,result}.ts  │  无业务语义
└──────────────────────────────────────────────────┘
依赖方向：app/api → modules → lib。禁止反向，禁止跨模块直接 import repository。
```

跨模块协作只走 `service` 的公开函数（如 `correlation.service` 调用 `alerts.service.listActive()`），不允许直接读别的模块的表。

---

## 7. 仓库目录结构（Agent 落盘必须严格对齐）

```
netscope/
├─ AGENTS.md                        # AI Agent 全局行为契约（第 14 节给出全文）
├─ README.md
├─ LICENSE                          # MIT
├─ CONTRIBUTING.md
├─ .env.example
├─ .gitignore
├─ docker-compose.yml
├─ package.json
├─ tsconfig.json
├─ next.config.ts
├─ vitest.config.ts
├─ playwright.config.ts
├─ .github/workflows/ci.yml
│
├─ prisma/
│  ├─ schema.prisma
│  └─ migrations/
│
├─ docs/
│  ├─ PROJECT-FRAMEWORK.md          # 本文档（唯一事实源）
│  ├─ PRD.md                        # 产品需求（由本文第 1-4、19 节展开）
│  ├─ ARCHITECTURE.md               # 架构详述（第 6、8、9 节展开）
│  ├─ API.md                        # 端点详表 + 示例请求响应
│  ├─ DESIGN-SYSTEM.md              # Token + 组件规范（第 12 节展开）
│  ├─ AGENT-TASKS.md                # 任务卡看板（第 14.4 节，随进度勾选）
│  ├─ STATE.md                      # 当前进度/阻塞/下一步（Agent 每次必读必写）
│  ├─ adr/ADR-001-nextjs-fullstack.md
│  └─ decisions/OPEN-DECISIONS.md
│
├─ src/
│  ├─ app/
│  │  ├─ layout.tsx
│  │  ├─ globals.css                # 设计 Token 唯一入口
│  │  ├─ (console)/
│  │  │  ├─ layout.tsx              # 侧边栏 + 顶栏
│  │  │  ├─ page.tsx                # /overview 概览
│  │  │  ├─ alerts/page.tsx         # /alerts 告警流
│  │  │  ├─ incidents/page.tsx      # /incidents 事件列表
│  │  │  ├─ incidents/[id]/page.tsx # /incidents/:id 工作台
│  │  │  ├─ topology/page.tsx       # /topology
│  │  │  ├─ cases/page.tsx          # /cases
│  │  │  └─ settings/page.tsx       # /settings
│  │  └─ api/
│  │     ├─ health/route.ts
│  │     └─ v1/
│  │        ├─ devices/route.ts
│  │        ├─ devices/[id]/route.ts
│  │        ├─ links/route.ts
│  │        ├─ topology/route.ts
│  │        ├─ alerts/route.ts
│  │        ├─ ingest/alerts/route.ts
│  │        ├─ ingest/simulate/route.ts
│  │        ├─ correlation/run/route.ts
│  │        ├─ incidents/route.ts
│  │        ├─ incidents/[id]/route.ts
│  │        ├─ incidents/[id]/analyze/route.ts   # SSE 流式
│  │        ├─ incidents/[id]/report/route.ts
│  │        ├─ cases/route.ts
│  │        ├─ cases/search/route.ts
│  │        └─ metrics/overview/route.ts
│  │
│  ├─ modules/
│  │  ├─ topology/{service,repository,schema,types}.ts
│  │  ├─ alerts/{service,repository,schema,normalize,suppress,fingerprint}.ts
│  │  ├─ ingest/{service,parsers/csv.ts,parsers/json.ts}.ts
│  │  ├─ correlation/{service,cluster,affinity}.ts
│  │  ├─ incidents/{service,repository,stateMachine,schema}.ts
│  │  ├─ rca/{service,context,prompt,analyze,verify,fallback}.ts
│  │  ├─ case/{service,repository,retrieval}.ts
│  │  └─ report/{service,template}.ts
│  │
│  ├─ lib/
│  │  ├─ db.ts                       # Prisma 单例
│  │  ├─ llm/{client,json,sse,usage}.ts
│  │  ├─ logger.ts
│  │  ├─ errors.ts                   # AppError + 错误码
│  │  ├─ result.ts                   # ok/err 包装
│  │  └─ utils/{date,id,format}.ts
│  │
│  ├─ components/
│  │  ├─ ui/                         # shadcn 原子组件（button/input/table/dialog...）
│  │  ├─ layout/{sidebar,topbar}.tsx
│  │  ├─ domain/
│  │  │  ├─ incident-card.tsx
│  │  │  ├─ alert-table.tsx
│  │  │  ├─ topology-canvas.tsx
│  │  │  ├─ hypothesis-panel.tsx
│  │  │  ├─ evidence-list.tsx
│  │  │  ├─ severity-badge.tsx
│  │  │  └─ metric-card.tsx
│  │  └─ charts/{alert-trend,severity-pie}.tsx
│  │
│  └─ types/{api.ts,domain.ts}
│
├─ scripts/
│  ├─ seed.ts                        # 设备+拓扑+历史案例
│  ├─ simulate.ts                    # 故障剧本注入 CLI
│  └─ fixtures/scenarios/
│     ├─ core-switch-board-failure.json
│     ├─ optical-module-degradation.json
│     ├─ routing-policy-change.json
│     ├─ dns-overload.json
│     └─ upstream-isp-flap.json
│
├─ evals/
│  ├─ dataset/{case-01..10}.json     # 标注好的故障→根因
│  └─ run.ts                         # 跑 Top1/Top3/证据有效率
│
└─ tests/
   ├─ unit/                          # 与 modules 同目录也可，二选一：放模块内
   └─ e2e/{happy-path.spec.ts,incident-flow.spec.ts}
```

文件规模红线：单个 `.tsx/.ts` ≤ 300 行，超过必须拆；`page.tsx` ≤ 120 行（只做数据获取 + 组件拼装）。

---

## 8. 数据模型（Prisma）

```prisma
generator client { provider = "prisma-client-js" }
datasource db { provider = "postgresql"  url = env("DATABASE_URL") }

enum DeviceType { ROUTER SWITCH FIREWALL LOAD_BALANCER SERVER ACCESS_POINT LINK }
enum Severity   { P0 P1 P2 P3 }
enum AlertStatus { ACTIVE SUPPRESSED RESOLVED }
enum IncidentStatus { OPEN ANALYZING LOCATED MITIGATED RESOLVED CLOSED }
enum LinkStatus { UP DOWN DEGRADED }

model Device {
  id        String     @id @default(cuid())
  name      String     @unique
  type      DeviceType
  vendor    String?
  model     String?
  ip        String?
  site      String?
  layer     Int        @default(3)      // 1 核心 2 汇聚 3 接入
  createdAt DateTime   @default(now())
  alerts    Alert[]
  fingerprints AlertFingerprint[]
  changes   ChangeRecord[]
  linksFrom TopologyLink[] @relation("src")
  linksTo   TopologyLink[] @relation("dst")
  @@index([type, site])
}

model TopologyLink {
  id       String     @id @default(cuid())
  sourceId String
  targetId String
  bandwidth Int?       // Mbps
  status   LinkStatus @default(UP)
  source   Device     @relation("src", fields: [sourceId], references: [id], onDelete: Cascade)
  target   Device     @relation("dst", fields: [targetId], references: [id], onDelete: Cascade)
  @@unique([sourceId, targetId])
  @@index([sourceId]) @@index([targetId])
}

model AlertFingerprint {
  id        String   @id @default(cuid())
  signature String   @unique              // sha1(deviceId|type|metric) 稳定定义，无时间语义
  deviceId  String
  type      String                        // LINK_DOWN / HIGH_LATENCY / PACKET_LOSS / CPU_HIGH ...
  metric    String?
  severity  Severity
  device    Device   @relation(fields: [deviceId], references: [id], onDelete: Cascade)
  alerts    Alert[]
  @@index([deviceId, type])
}

model Alert {
  id            String      @id @default(cuid())
  fingerprintId String
  severity      Severity
  value         Float?
  threshold     Float?
  message       String
  status        AlertStatus @default(ACTIVE)
  count         Int         @default(1)     // 本周期内重复次数
  firstSeen     DateTime                     // 本周期首次出现
  lastSeen      DateTime                     // 本周期最近出现
  cycleStart    DateTime                     // 周期起点 = firstSeen，用于唯一约束
  externalKey   String?                      // 外部系统告警 ID，导入幂等用
  raw           Json?
  incidentId    String?
  fingerprint   AlertFingerprint @relation(fields: [fingerprintId], references: [id], onDelete: Cascade)
  incident      Incident?   @relation(fields: [incidentId], references: [id])
  @@unique([fingerprintId, cycleStart])     // 同一指纹同一周期只有一行
  @@unique([externalKey])                    // 有外部 ID 时按外部 ID 幂等
  @@index([status, lastSeen]) @@index([incidentId])
}

model ChangeRecord {
  id        String   @id @default(cuid())
  deviceId  String
  kind      String                         // CONFIG / FIRMWARE / HARDWARE / CABLING
  content   String
  operator  String?
  changedAt DateTime
  device    Device   @relation(fields: [deviceId], references: [id], onDelete: Cascade)
  @@index([deviceId, changedAt])
}

model Incident {
  id            String         @id @default(cuid())
  code          String         @unique     // INC-20261119-001
  title         String
  status        IncidentStatus @default(OPEN)
  severity      Severity
  summary       String?                     // AI 生成的一句话结论
  impactScope   String?                     // 影响面描述
  startedAt     DateTime
  locatedAt     DateTime?
  resolvedAt    DateTime?
  mttrSeconds   Int?
  clusterKey    String?        @unique      // sha1(排序后的 fingerprintId)，聚合 upsert 幂等
  mergedIntoId  String?                     // B3 被并入的目标事件
  reopenedFromId String?                    // B6 重开自哪个事件
  reopenedCount Int            @default(0)
  closedReason  String?                     // MANUAL | AUTO_MERGED | AUTO_NOISE | AUTO_CLOSED
  alerts        Alert[]
  hypotheses    Hypothesis[]
  reports       Report[]
  cases         CaseRecord[]
  createdAt     DateTime       @default(now())
  @@index([status, startedAt]) @@index([severity])
}

model Hypothesis {
  id         String   @id @default(cuid())
  incidentId String
  rank       Int
  cause      String
  category   String                        // HARDWARE / CONFIG / LINK / CAPACITY / UPSTREAM / OTHER
  confidence Float
  evidence   Json                          // [{type:'ALERT'|'CHANGE'|'TOPOLOGY'|'CASE', ref:string, desc:string}]
  verifySteps Json                        // string[]
  actions    Json                          // [{action, risk:'LOW'|'MEDIUM'|'HIGH', requiresApproval:boolean}]
  source     String                        // LLM | RULE_FALLBACK
  model      String?
  tokensUsed Int?
  createdAt  DateTime @default(now())
  incident   Incident @relation(fields: [incidentId], references: [id], onDelete: Cascade)
  @@index([incidentId, rank])
}

model CaseRecord {
  id         String   @id @default(cuid())
  incidentId String   @unique
  title      String
  symptom    String                        // 现象描述，用于检索
  rootCause  String
  resolution String
  tags       String[]                      // Postgres text[]
  embedding  Unsupported("vector(1536)")?  // P1 启用，MVP 留空
  createdAt  DateTime @default(now())
  incident   Incident @relation(fields: [incidentId], references: [id], onDelete: Cascade)
  @@index([title])
}

model Report {
  id         String   @id @default(cuid())
  incidentId String
  markdown   String
  createdAt  DateTime @default(now())
  incident   Incident @relation(fields: [incidentId], references: [id], onDelete: Cascade)
  @@index([incidentId])
}
```

关键设计说明：

- **指纹与发生分离**：`AlertFingerprint` 只描述"什么设备出了什么类型的告警"（稳定定义，无时间语义）；`Alert` 表示一次实际告警周期。同一故障隔天再次发生会生成新的 Alert 行，`firstSeen` 从零开始，历史不会被污染。这是评审指出的原设计缺陷，v0.2 已修正。
- **去重幂等的两层保障**：`(fingerprintId, cycleStart)` 唯一约束防同周期重复入库；有外部告警 ID 时 `externalKey` 唯一约束直接按上游 ID 幂等。
- `Hypothesis.evidence` 用 JSON 而非关联表 → 证据异构（告警/变更/拓扑/案例），且需整体校验；用 JSON 保留原始引用便于前端直接跳转。
- `Incident.clusterKey` = `sha1(排序后的 fingerprintId 列表)` → 同一批告警重复聚合走 upsert，不产生重复事件（B8 幂等的落点）。
- 不用软删除（MVP 阶段无合规要求），`onDelete: Cascade` 保证测试数据可一键清。

---

## 9. API 契约

约定：全部 `/api/v1` 前缀；JSON；成功 `200/201`，错误统一 `{ error: { code, message, details? } }`；列表统一 `{ items, total, page, pageSize }`。

| # | Method | Path | 说明 | 关键参数 / 备注 |
|---|---|---|---|---|
| 1 | GET | `/health` | 健康检查 | 返回 `{status,db,llm:'up'\|'mock'}` |
| 2 | GET | `/api/v1/devices` | 设备列表 | `?type=&site=&q=` |
| 3 | POST | `/api/v1/devices` | 新建设备 | body: name/type/ip/site/layer |
| 4 | PATCH | `/api/v1/devices/[id]` | 更新设备 | 部分字段 |
| 5 | DELETE | `/api/v1/devices/[id]` | 删除设备 | 级联删链路 |
| 6 | GET | `/api/v1/topology` | 拓扑图数据 | 返回 `{nodes, edges}` 可直接喂 React Flow |
| 7 | POST | `/api/v1/links` | 新建链路 | sourceId/targetId/bandwidth |
| 8 | GET | `/api/v1/alerts` | 告警列表 | `?status=&severity=&deviceId=&from=&to=&page=` |
| 9 | POST | `/api/v1/ingest/alerts` | 批量导入告警 | body: `{source, alerts:[...]}`，返回 `{accepted, deduped, suppressed}` |
| 10 | POST | `/api/v1/ingest/simulate` | 注入故障剧本 | body: `{scenario, seed?}`，返回生成的 incidentId |
| 11 | POST | `/api/v1/correlation/run` | 手动触发聚合 | 返回新建/更新的 incidents |
| 12 | GET | `/api/v1/incidents` | 事件列表 | `?status=&severity=&from=` |
| 13 | GET | `/api/v1/incidents/[id]` | 事件详情 | 含 alerts、hypotheses、timeline |
| 14 | PATCH | `/api/v1/incidents/[id]` | 状态流转 | body: `{status, note?}`，非法流转返回 409 |
| 15 | POST | `/api/v1/incidents/[id]/analyze` | **AI 研判（SSE）** | 流式返回 `stage` 事件 + 最终 `hypotheses` |
| 16 | POST | `/api/v1/incidents/[id]/report` | 生成复盘报告 | 返回 markdown 文本 |
| 17 | GET | `/api/v1/cases` | 案例列表 | `?q=&tag=` |
| 18 | GET | `/api/v1/cases/search` | 相似案例检索 | `?q=&incidentId=&limit=3` |
| 19 | GET | `/api/v1/metrics/overview` | 概览指标 | 活跃事件数/24h 告警数/平均 MTTR/降噪率 |

> 设备与链路的写接口（2/3/4/7）在 MVP-0 只用于 seed 与调试，前端不开放；P1 拓扑编辑启用时才做鉴权与并发校验。

错误码（`lib/errors.ts` 统一）：

| code | HTTP | 场景 |
|---|---|---|
| `VALIDATION_FAILED` | 400 | zod 校验失败，details 带字段路径 |
| `NOT_FOUND` | 404 | 资源不存在 |
| `INVALID_TRANSITION` | 409 | 事件状态非法流转 |
| `DUPLICATE_FINGERPRINT` | 409 | 唯一键冲突（正常情况应内部消化） |
| `LLM_UNAVAILABLE` | 503 | 模型超时且降级也失败 |
| `INTERNAL` | 500 | 兜底，日志带 traceId |

---

## 10. AI 层设计（项目技术含量所在）

### 10.1 上下文组装（Context Builder）

单次研判的输入严格控制在 6k tokens 以内：

```
[角色] 你是网络运维专家...
[任务] 基于下列证据定位根因，只能引用给定 ID 作为证据
[事件] 标题/严重度/起止时间/影响设备数
[告警] 按严重度排序 Top20（id, device, type, metric, value, firstSeen, count）
[拓扑] 2 跳邻域（设备-链路-设备 文本化，标注链路状态）
[指标] 涉及设备的 CPU/内存/端口错包 最近快照
[变更] 24h 内相关设备变更（id, kind, content, changedAt）
[历史] Top3 相似案例（symptom → rootCause → resolution）
[输出] 严格 JSON，符合给定 schema，无证据的假设必须丢弃
```

超过预算时的裁剪顺序：指标 → 历史 → 拓扑（保留 1 跳）→ 告警（Top10）。裁剪逻辑写在 `rca/context.ts` 并单测覆盖。

### 10.2 输出契约（Zod 定义，同时用于 LLM 校验与前端类型）

```ts
export const HypothesisSchema = z.object({
  cause: z.string().min(4).max(120),
  category: z.enum(['HARDWARE','CONFIG','LINK','CAPACITY','UPSTREAM','OTHER']),
  confidence: z.number().min(0).max(1),
  evidence: z.array(z.object({
    type: z.enum(['ALERT','CHANGE','TOPOLOGY','CASE']),
    ref: z.string(),                 // 必须是真实存在的 id
    desc: z.string().max(160),
  })).min(1),
  verifySteps: z.array(z.string()).min(1).max(5),
  actions: z.array(z.object({
    action: z.string(),
    risk: z.enum(['LOW','MEDIUM','HIGH']),
    requiresApproval: z.boolean(),
  })).max(5),
})

export const AnalysisResultSchema = z.object({
  summary: z.string().max(200),
  impactScope: z.string().max(200),
  severity: z.enum(['P0','P1','P2','P3']),
  hypotheses: z.array(HypothesisSchema).min(1).max(3),
  missingInfo: z.array(z.string()).max(5),
})
```

### 10.3 证据校验器（Verify）— 三级校验，别叫它"反幻觉"

先纠正表述：**证据引用存在，不等于根因判断正确**。校验器能做的是"减少无依据输出 + 让结论可审计"，不能证明结论对。所以这里做三级，逐级加严：

```
L1 存在性（硬性，必过）
   e.ref 必须命中库内真实 id（alertId / changeId / linkId / caseId）
   不通过 -> 整条假设丢弃，记 dropped_by_verifier + reason

L2 相关性（硬性，必过）
   ALERT    证据的设备必须 ∈ 事件设备集，或与事件设备拓扑距离 ≤ 2 跳
   CHANGE   证据的变更设备同上；且 changedAt 必须早于事件首个告警（后发生的变更不能当原因）
   TOPOLOGY 链路两端至少一端 ∈ 事件设备集
   CASE     案例的 tags 必须与事件告警类型有交集
   不通过 -> 该条证据剔除；假设剩余证据为 0 则整条丢弃

L3 一致性（软性，只降权不丢弃）
   confidence *= 0.6 + 0.4 * (有效证据数 / 原始证据数)
   命中"变更与告警间隔 < 60s"时额外 * 0.9（太巧合，可能是结果而非原因）
```

校验后若全部被丢弃 → 返回 `{ hypotheses: [], missingInfo: ['证据不足，建议补充 XXX'] }`，前端展示空态而不是编造结论。

**说得清能力边界**（README 原话）：L1/L2 能拦住"引用幻觉"和"张冠李戴"，拦不住"证据都对但推理错了"——后者只能靠评测集与人工接受率衡量。这句话比"解决了幻觉"更值钱。

```ts
// 校验结果要落库，用于 eval 与事后审计
type VerifyResult = {
  kept: Hypothesis[]
  dropped: { cause: string; reason: 'NO_EVIDENCE' | 'EVIDENCE_NOT_FOUND' | 'EVIDENCE_IRRELEVANT' }[]
  stats: { rawEvidence: number; validEvidence: number; relevanceRate: number }
}
```

### 10.4 调用策略

| 策略 | 实现 |
|---|---|
| 模型分层 | 摘要/分类用 `LLM_MODEL_FAST`，根因推理用 `LLM_MODEL_REASON` |
| 结构化输出 | `response_format: json_object` + Zod 校验 + 1 次修复重试（把校验错误回喂） |
| 超时 | 30s 硬超时；MVP-0 前端点击后立即渲染阶段文案并 1.5s 轮询进度，P1 换 SSE |
| 降级 | 无 key / 连续失败 → `rca/fallback.ts` 规则打分：变更相关 +40，直连告警 +30，类型权重 +20，历史相似 +10 |
| 幂等 | 同一 incident 5 分钟内不重复调用，除非手动强制 |
| 成本 | 单次 < 6k in / 1k out；开发期用 mock 模式（`LLM_MOCK=true` 返回固定 fixture，零成本跑通全链路） |
| 可观测 | 每次调用落 `Hypothesis.tokensUsed/model`，设置页展示累计消耗 |

### 10.5 评测（evals/）— 24 个场景，dev / test 分离

评审指出 10 个剧本会"被模型识别出剧本模式"，这个判断是对的。v0.2 调整为：

**场景构成（24 个）**

| 类别 | 数量 | 说明 |
|---|---|---|
| 正例 | 8 | 5 套基础剧本 + 3 套变体（换设备、换厂商、改时间顺序） |
| 干扰例 | 8 | 正常噪声告警混入、相似但不同根因（光模块劣化 vs 链路拥塞）、误导性变更记录（变更与故障无关但时间接近） |
| 对抗例 | 8 | 缺失拓扑数据、两故障同时发生、证据不足（应返回空假设）、LLM 输出格式错误、引用存在但不相关的证据、父告警晚到、跨窗口持续、结案后 20 分钟复发 |

**数据划分（防过拟合的硬规则）**

- `evals/dev/` 16 个：可以看、可以据此调 prompt 和阈值。
- `evals/test/` 8 个：**调参期间禁止查看**，只在里程碑验收时跑一次，跑完记录在案。分数只报 test 集。

**指标（分三层，别混着报）**

| 层 | 指标 | 定义 | 目标 |
|---|---|---|---|
| 聚合层 | 告警压缩比 | 原始告警数 / 事件数 | ≥ 8:1 |
| 聚合层 | Incident Precision | 生成事件中真实对应故障的比例 | ≥ 0.85 |
| 聚合层 | Incident Recall | 已知故障中被成功聚合的比例 | ≥ 0.90 |
| 聚合层 | 根因告警误抑制率 | 被抑制的标注根因告警 / 标注根因告警总数 | = 0 |
| 研判层 | Top1 命中率（test 集） | 第一假设 category + 关键设备与标注一致 | ≥ 0.50 |
| 研判层 | Top3 命中率（test 集） | 前三假设包含正确根因 | ≥ 0.80 |
| 研判层 | 证据存在率 | L1 通过证据 / 原始证据 | ≥ 0.95 |
| 研判层 | 证据相关率 | L2 通过证据 / 原始证据 | 报告值，不设目标（先看清基线） |
| 研判层 | 人工接受率 | 采纳首选建议的事件 / 总事件（自己当评审标 20 条） | 报告值 |
| 工程层 | JSON 合法率 | 一次通过 Zod 校验的比例 | ≥ 0.98 |
| 工程层 | 平均研判耗时 | 端到端 | < 8s |

跑法：`npm run eval -- --set=test`，输出 Markdown 表格直接贴进 README。**分数不好看就如实写**——"Top3 65%，主要失败在缺拓扑场景"比编一个 95% 更能体现工程判断力。

---

## 11. 前端架构

### 11.1 页面清单

| 路由 | 页面 | 核心内容 | 数据来源 |
|---|---|---|---|
| `/overview` | 概览 | 4 张指标卡 + 24h 告警趋势 + 活跃事件列表（按严重度） | metrics/overview, incidents |
| `/alerts` | 告警流 | 可筛选表格（严重度/状态/设备/时间），行内跳事件 | alerts |
| `/incidents` | 事件列表 | 卡片列表 + 状态分段器 + 严重度色条 | incidents |
| `/incidents/[id]` | **事件详情** | 三栏：左时间线 / 中拓扑影响设备高亮 / 右根因与证据面板 | incidents/[id], analyze(轮询→P1 SSE) |
| `/topology` | 拓扑 | React Flow 只读画布：按层级布局、按类型着色、链路状态着色、点击设备看关联事件 | topology |
| `/cases` | 案例库 | 搜索框 + 案例卡片 + 相似推荐 | cases |
| `/settings` | 设置 | 模型配置（只读展示 env）、聚合阈值、剧本注入入口 | - |

### 11.2 组件与状态规则

- Server Component 负责取数（直接调 `module.service`，不绕 HTTP），Client Component 只负责交互。
- 需要 mutation 的页面用 TanStack Query，`queryKey` 统一为 `['incidents', filters]` 这种数组形式。
- Zustand 只放三样：侧边栏折叠、筛选面板状态、当前选中节点 id。**业务数据一律不进 store**。
- AI 研判面板：MVP-0 用 1.5s 轮询取进度，按阶段渲染 `正在聚合告警 → 检索相似案例 → 推理 → 校验证据`，避免 8 秒白屏；P1 换 `EventSource`，组件对外接口不变。
- 表格超过 200 行启用虚拟滚动（`@tanstack/react-virtual`，按需引入）。

### 11.3 交互硬规范

| 场景 | 必须 |
|---|---|
| 加载 | 骨架屏（尺寸与实际内容一致，禁止跳动） |
| 空态 | 说明为什么空 + 一个明确动作（如"导入告警"） |
| 错误 | 展示错误码 + 重试按钮，禁止只弹 toast |
| 危险操作 | 二次确认弹窗，按钮文案是动词（"删除设备"而非"确定"） |
| 严重度 | 色 + 文字双编码（P0 + 红），不靠颜色单独传达信息 |
| 时间 | 相对时间 + hover 显示绝对时间（`date-fns`） |
| 无数据可演示 | 概览页提供"加载示例数据"入口，指向 `POST /ingest/simulate` |

---

## 12. 设计系统 Token

风格基调：**运维控制台 / 深钢蓝 + 青**，信息密度高、边界清晰、无装饰。对标 Linear 的克制 + Grafana 的信息密度。禁用任何渐变、发光、毛玻璃。

```css
/* src/app/globals.css — 唯一颜色来源，组件里禁止出现硬编码色值 */
@import "tailwindcss";

:root {
  --color-bg:             #F7F8FA;
  --color-surface:        #FFFFFF;
  --color-surface-muted:  #F1F3F6;
  --color-border:         #E3E6EB;
  --color-border-strong:  #CBD2DA;

  --color-text:           #16191D;
  --color-text-secondary: #5A6472;
  --color-text-tertiary:  #8A93A0;
  --color-text-inverse:   #FFFFFF;

  --color-primary:        #1B4F8F;
  --color-primary-hover:  #164178;
  --color-primary-soft:   #E8F0FA;
  --color-accent:         #0F766E;

  --color-sev-p0:         #B42318;
  --color-sev-p1:         #B54708;
  --color-sev-p2:         #175CD3;
  --color-sev-p3:         #667085;

  --color-ok:             #067647;
  --color-warn:           #B54708;
  --color-danger:         #B42318;
  --color-info:           #175CD3;

  --radius-sm: 6px;  --radius-md: 8px;  --radius-lg: 12px;
  --space-1: 4px; --space-2: 8px; --space-3: 12px; --space-4: 16px;
  --space-5: 20px; --space-6: 24px; --space-8: 32px; --space-10: 40px;

  --font-sans: Inter, "Noto Sans SC", system-ui, sans-serif;
  --font-mono: "JetBrains Mono", ui-monospace, monospace;

  --shadow-card: 0 1px 2px rgba(16, 24, 40, 0.06);
}

@theme inline {
  --color-bg: var(--color-bg);
  --color-surface: var(--color-surface);
  --color-primary: var(--color-primary);
  --color-sev-p0: var(--color-sev-p0);
  /* 其余同理映射，供 Tailwind 类名 bg-surface / text-sev-p0 使用 */
}
```

| 维度 | 规范 |
|---|---|
| 字号 | 12 / 13 / 14（正文）/ 16（区块标题）/ 20（页面标题）/ 28（指标数字） |
| 字重 | 400 / 500，仅两档 |
| 图标 | Lucide，16（行内）/ 20（按钮）/ 24（导航），`stroke-width={1.5}` |
| 卡片 | `bg-surface border border-[--color-border] rounded-[--radius-lg] shadow-card`，内边距 20px |
| 表格 | 行高 44px，表头 `text-text-secondary` + `surface-muted`，无斑马纹，只有横向分隔线 |
| 按钮 | 主按钮实心 primary，次按钮描边，高度 36px，圆角 8px |
| 严重度徽标 | 左侧 2px 色条 + 文字，禁止整块高饱和底色 |
| 深色模式 | P1，Token 已预留，MVP 不实现 |

---

## 13. 工程规范

### 13.1 命名与分层

- 文件 kebab-case，组件 PascalCase，函数 camelCase，常量 SCREAMING_SNAKE，类型 PascalCase。
- `service` 只做业务编排，**不写 SQL**；`repository` 只做数据访问，**不做判断**。
- `route.ts` 不超过 40 行：parse → zod → service.call → `NextResponse.json` / 捕获 `AppError` 映射状态码。
- 禁止 `any`；外部输入一律 `unknown` + zod 收窄；`tsconfig` 开 `noUncheckedIndexedAccess`。

### 13.2 错误与日志

- 统一 `AppError(code, httpStatus, message, details?)`；未捕获异常由 `lib/errors.ts` 的 `toResponse()` 兜底。
- 每个请求生成 `traceId`（cuid），写入日志与响应头 `x-trace-id`。
- 日志字段固定：`{traceId, module, action, durationMs, err?}`；禁止 `console.log`（ESLint 规则拦截）。

### 13.3 安全

- LLM Key 只在服务端读取，禁止 `NEXT_PUBLIC_` 前缀。
- 所有列表查询走 Prisma 参数化，禁止字符串拼 SQL。
- 导入的告警 `message` 前端渲染时按纯文本处理，禁止 `dangerouslySetInnerHTML`。
- API 无鉴权（本地 MVP），但所有 route 预留 `withAuth()` 包装位置，P1 接入后一键开启。
- 请求体大小限制 2MB（`next.config.ts` 中配置），CSV 导入分批 500 条。

### 13.4 性能

| 指标 | 目标 |
|---|---|
| 首屏 LCP | < 2.5s（本地） |
| API p95（不含 LLM） | < 300ms |
| 聚合 500 条告警 | < 500ms（纯内存计算，一次查询取回） |
| AI 研判首个反馈 | < 1s（点击后立即渲染阶段提示，不等模型返回） |

---

## 14. Agentic Coding 手册

这一节是给 AI Agent 看的操作手册，你（人类）只需要按顺序丢任务卡。

### 14.1 上下文分层（每轮喂什么）

| 层 | 文件 | 作用 | 是否每轮必读 |
|---|---|---|---|
| L1 全局契约 | `AGENTS.md` | 不可违反的规则 | 是 |
| L2 项目事实源 | `docs/PROJECT-FRAMEWORK.md` | 架构/数据/API 唯一依据 | 是（可按节引用） |
| L3 当前状态 | `docs/STATE.md` | 做到哪了、卡在哪、下一步 | 是 |
| L4 任务卡 | `docs/AGENT-TASKS.md` | 本次要做什么、怎么验收 | 是（只读当前卡） |
| L5 模块上下文 | 目标模块目录 | 已有代码风格 | 按需 |

**关键**：不要让 Agent 一次读全仓库。开局只喂 L1 + L2 的相关节 + L3 + 一张任务卡。这能把幻觉率降下来。

### 14.2 `AGENTS.md` 全文（直接落盘）

```markdown
# AGENTS.md

## 项目
NetScope — 网络故障智能研判平台。唯一事实源：docs/PROJECT-FRAMEWORK.md。
任何与本文档冲突的实现，以文档为准；文档确实有误时，先改文档再改代码。

## 每次开始前
1. 读 docs/STATE.md 的「当前任务」与「阻塞」
2. 读本次任务卡（docs/AGENT-TASKS.md 中对应 Txx）
3. 只改任务卡声明的文件范围

## 铁律
- 分层：app/api → modules → lib，禁止反向依赖，禁止跨模块 import repository
- 单文件 ≤ 300 行，page.tsx ≤ 120 行
- 图标只用 lucide-react，禁止 emoji 作图标，禁止引入第二套 UI 库
- 颜色只用 globals.css 中的 CSS 变量，禁止硬编码（#fff/#000 除外）
- 禁止 any；输入用 unknown + zod
- 不新增依赖：需新增时先在 STATE.md 记「请求新增依赖：xxx，理由」，等确认
- 数据库改动必须同时提供 migration 与 seed 兼容说明
- 改 API 必须同步更新 docs/API.md

## 每次结束前（缺一不可）
npm run lint && npm run typecheck && npm run test
然后更新 docs/STATE.md：已完成 / 未完成 / 下一步 / 新发现的坑

## 失败处理
同一问题连续 3 次修复失败 → 停止，写进 STATE.md 的「阻塞」，不要继续瞎改。
```

### 14.3 任务卡模板

```markdown
### T{xx} {标题}
- 目标：一句话，可验证
- 依赖：T{yy}（前置必须已完成）
- 改动范围：src/modules/xxx/**, prisma/schema.prisma（仅新增字段 a,b）
- 输入契约：{接口签名或 zod schema}
- 验收命令：
  - npm run test -- xxx
  - curl ... | jq 断言 xxx
- 禁止：改其它模块；新增依赖；动 UI 组件库
- 完成后：勾选本卡 + 更新 STATE.md
```

### 14.4 十张任务卡（按序执行，别跳）

| 卡 | 标题 | 依赖 | 验收要点 |
|---|---|---|---|
| T01 | 工程基座 | - | `npm run build` 通过；`/api/health` 返回 db:up；globals.css 含全部 Token；ESLint/Prettier/CI 就位 |
| T02 | 数据模型与种子 | T01 | `db:push` 成功；含 `AlertFingerprint`/`Alert` 两表；seed 生成 30 设备 + 60 链路 + 30 条历史案例 |
| T03 | 告警接入 + 模拟器 | T02 | 5 套剧本可注入；CSV/JSON 导入；有 `externalKey` 时按上游 ID 幂等；解析容错（缺列/脏数据不炸） |
| T04 | 归一化 + 抑制 + 生命周期 | T03 | 指纹去重 ≥ 6 用例；父告警抑制生效且 B9 晚到回溯有效；30 分钟重开规则单测覆盖 |
| T05 | 关联聚合 | T04 | B1–B9 每条都有对应单测；500 条告警 < 500ms；重复跑结果完全一致（幂等断言） |
| T06 | 事件详情（只读拓扑） | T05 | 事件信息 + 关联告警列表 + 拓扑影响设备高亮；空态/加载态/错误态齐备 |
| T07 | 根因研判 | T06 | 规则 fallback 先跑通；LLM 结构化输出；L1/L2/L3 三级校验有单测；无 key 全链路可用 |
| T08 | 人工确认 + 简版报告 | T07 | 采纳/否决假设可落库；状态机非法流转 409；报告含 MTTR/影响面/根因/改进项四段 |
| T09 | 评测与发布 | T08 | test 集跑分出表；E2E 两条主流程通过；README 含截图与评测数据；Docker 一键起 |

> P1 才做的卡（拓扑编辑、SSE、案例相似推荐）不进 MVP-0 队列，写完 T09 再开新卡，避免中途分心。

每张卡的详细版（含涉及文件清单）在 `docs/AGENT-TASKS.md`，随 T01 一起生成。

### 14.5 Agent 循环协议

```
loop:
  1. 读 STATE.md → 取「下一张卡」
  2. 读卡 → 确认依赖已完成 → 列出要改的文件（先列后改）
  3. 实现（一次只做一张卡，不顺手优化别的）
  4. 跑 lint / typecheck / test
  5. 失败 → 读错误 → 修 → 重跑（最多 3 轮）
  6. 通过 → 更新 STATE.md → git commit（Conventional Commits）
  7. 卡上有"需人工确认"标记 → 停下等人
```

### 14.6 防幻觉六条（针对大模型的已知失效模式）

1. **版本锚定**：写代码前先看 `package.json` 实际版本，不按记忆写 API（Next 15 的 `params` 是 Promise）。
2. **不臆造端点**：所有 fetch 的 URL 必须在第 9 节表里存在。
3. **类型从源头推导**：API 类型从 Prisma + Zod `z.infer` 得出，不手写重复接口。
4. **不建"备用"实现**：一个功能只有一条路径，禁止 `xxx-v2.ts`、`xxx-new.ts`。
5. **不写"以后会用"的代码**：抽象必须有两个以上调用方。
6. **不确定就停**：查文档 > 猜。三次失败即上报。

### 14.7 提交规范

```
feat(topology): 拓扑画布支持拖拽布局
fix(correlation): 修复跨日时间窗聚合漏簇
docs(framework): 补充证据校验器说明
test(rca): 增加校验器丢弃逻辑用例
```

分支：`main` 保护，功能分支 `feat/T08-rca`，一卡一 PR（自己 merge 也行，但保留 PR 记录，这是给面试官看的工程习惯）。

---

## 15. 测试与质量门禁

| 层 | 工具 | 覆盖要求 |
|---|---|---|
| 单测 | Vitest | `modules/**` 的纯函数必须有测试：fingerprint / suppress / cluster / verify / fallback / report 模板 |
| 集成 | Vitest + 测试库 | 关键 route 的成功 + 失败路径（400/404/409） |
| E2E | Playwright | ① 概览→事件详情→研判→结案 ② 剧本注入→事件生成→报告导出 |
| 评测 | `npm run eval` | Top1/Top3/证据有效率，写入 README |
| 门禁 | CI | lint + typecheck + test + build 全绿才允许 merge |

不做：为覆盖率而覆盖率。核心纯函数 80% 即可，UI 组件不强制单测（E2E 覆盖主流程）。

---

## 16. 部署与交付

### 16.1 `docker-compose.yml`

```yaml
services:
  db:
    image: pgvector/pgvector:pg16
    environment:
      POSTGRES_USER: netscope
      POSTGRES_PASSWORD: netscope
      POSTGRES_DB: netscope
    ports: ["5432:5432"]
    volumes: ["pgdata:/var/lib/postgresql/data"]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U netscope"]
      interval: 5s
      retries: 10

  app:
    build: .
    ports: ["3000:3000"]
    env_file: .env
    depends_on:
      db: { condition: service_healthy }

volumes:
  pgdata:
```

### 16.2 `.env.example`

```bash
DATABASE_URL="postgresql://netscope:netscope@localhost:5432/netscope?schema=public"

# LLM：OpenAI 兼容协议，DeepSeek / 通义 / OpenAI 均可
LLM_BASE_URL="https://api.deepseek.com/v1"
LLM_API_KEY=""                      # 留空自动进入 mock/降级模式
LLM_MODEL_FAST="deepseek-chat"
LLM_MODEL_REASON="deepseek-chat"
LLM_MOCK="false"                    # true = 返回 fixture，不产生费用

APP_BASE_URL="http://localhost:3000"
LOG_LEVEL="info"
SIM_DEFAULT_SEED="42"
```

### 16.3 `package.json` scripts

```json
{
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "lint": "next lint",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:e2e": "playwright test",
    "eval": "tsx evals/run.ts",
    "db:push": "prisma db push",
    "db:migrate": "prisma migrate dev",
    "db:seed": "tsx scripts/seed.ts",
    "sim": "tsx scripts/simulate.ts"
  }
}
```

### 16.4 CI（`.github/workflows/ci.yml`）

```yaml
name: ci
on: [push, pull_request]
jobs:
  build:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: pgvector/pgvector:pg16
        env:
          POSTGRES_USER: netscope
          POSTGRES_PASSWORD: netscope
          POSTGRES_DB: netscope
        ports: ["5432:5432"]
        options: >-
          --health-cmd "pg_isready -U netscope" --health-interval 5s --health-retries 10
    env:
      DATABASE_URL: postgresql://netscope:netscope@localhost:5432/netscope
      LLM_MOCK: "true"
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - run: npm run db:push
      - run: npm run lint
      - run: npm run typecheck
      - run: npm run test
      - run: npm run build
```

### 16.5 README 结构（决定别人是否 star）

```
1. 一句话 + 截图/GIF（事件工作台，最能打）
2. 为什么做这个（3 条痛点）
3. 核心能力（4 图或 4 段）
4. 架构图（mermaid）
5. 快速开始（5 行命令）
6. AI 研判是怎么工作的（含证据校验器亮点 + 评测数据表）
7. Roadmap
8. 技术栈
9. License
```

### 16.6 发布清单

- [ ] README 有真实截图（不许用占位图）
- [ ] `.env.example` 齐全，陌生人 5 分钟能跑
- [ ] MIT LICENSE
- [ ] CI 绿色徽章
- [ ] `v0.1.0` tag + Release notes
- [ ] GitHub Topics：`aiops` `network-monitoring` `root-cause-analysis` `llm` `nextjs` `incident-management`
- [ ] 仓库描述一句话说清定位

---

## 17. 里程碑

| 阶段 | 内容 | 完成标志 | 单人预估 |
|---|---|---|---|
| M0 基座 | T01–T02 | 本地起得来，seed 数据可查 | 2 天 |
| M1 有数据 | T03–T04 | 5 套剧本可注入，去重与生命周期正确 | 3 天 |
| M2 闭环 | T05–T07 | 告警自动聚成事件，能出带证据的根因 | 5 天 |
| M3 收口 | T08–T09 | 可结案、可出报告、评测跑分、可发布 | 4 天 |
| **MVP-0 合计** | | **纵向切片验收** | **约 14 天（+2 天 buffer）** |

M2 结束就该有第一张能发朋友圈的截图（事件详情 + 拓扑高亮 + 根因证据）。先有可看的东西，再谈智能。

P1 增量（约 3 周，视 MVP-0 评测结果取舍）：拓扑编辑 → SSE 流式 → 案例相似推荐 → 报告模板化。**先跑评测，再决定 P1 砍哪些**——如果 Top3 只有 60%，花时间做拓扑拖拽就是方向错了。

---

## 18. 风险与悬而未决

| 风险 | 影响 | 对策 |
|---|---|---|
| LLM 输出不稳定，假设质量差 | 核心卖点垮掉 | 证据校验器兜底 + 规则降级 + 评测集量化，不吹 100% 准确 |
| 无真实数据，演示单薄 | 说服力弱 | 5 套剧本覆盖典型故障链，数据贴近真实告警字段（参考 Zabbix/Prometheus 告警结构） |
| 聚合算法调参耗时 | 进度拖延 | 先用固定权重 + 阈值，M2 结束时用剧本回归调一次，不做自动学习 |
| 一人开发范围失控 | 做不完 | 严格按第 2 节，任何新想法进 P1 不进 P0 |

`docs/decisions/OPEN-DECISIONS.md` 初始条目：

| Date | 来源 | 待定项 | 当前倾向 | 阻塞于 | 何时关闭 | 状态 |
|---|---|---|---|---|---|---|
| 2026-11-19 | 架构 | 是否启用 pgvector 语义检索 | 暂不启用，字段预埋 | 案例量未知 | 案例 > 1000 时评估 | OPEN |
| 2026-11-19 | 架构 | 是否做实时 SSE 推送替换轮询 | P1 再换 | 无 | M3 结束后 | OPEN |
| 2026-11-19 | 产品 | 是否需要登录 | MVP 不做 | 无 | 有公网部署需求时 | OPEN |
| 2026-11-19 | 部署 | 部署目标（Vercel+Neon / 自建 Docker） | 先 Docker 本地，README 给两条路 | 无 | M4 | OPEN |

---

## 19. 验收标准（EARS）

| 编号 | 功能 | 验收标准 | 优先级 |
|---|---|---|---|
| AC-01 | 告警导入 | When 用户导入同一批告警两次，系统必须只更新 count 与 lastSeen，不新增记录 | P0 |
| AC-02 | 抑制 | While 设备离线告警处于 ACTIVE，该设备端口类告警必须标记为 SUPPRESSED 且不计入事件 | P0 |
| AC-03 | 聚合 | When 5 分钟窗口内同一设备簇的告警 ≥ 3 条且关联分 ≥ 0.55，系统必须生成 1 个 Incident | P0 |
| AC-04 | 聚合幂等 | If 同一批告警重复触发聚合，系统必须复用已有 Incident 而非新建 | P0 |
| AC-05 | 研判 | When 用户点击"开始研判"，系统必须在 1 秒内返回首个 SSE 阶段事件 | P0 |
| AC-06 | 证据存在性 | If LLM 返回的假设中证据引用均不存在于库内，系统必须丢弃该假设且不展示 | P0 |
| AC-07 | 降级 | If 未配置 LLM_API_KEY，系统必须使用规则引擎返回假设并标记 source=RULE_FALLBACK | P0 |
| AC-08 | 状态机 | If 用户尝试从 RESOLVED 回退到 OPEN，系统必须返回 409 INVALID_TRANSITION | P0 |
| AC-09 | 报告 | When 事件状态变为 RESOLVED，系统必须可生成含 MTTR、影响面、根因、改进项的报告 | P0 |
| AC-10 | 案例 | When 同类故障再次发生，系统必须在研判上下文中召回至少 1 条历史案例（若库中存在） | P1 |
| AC-11 | 性能 | While 导入 500 条告警，聚合接口必须在 500ms 内返回 | P1 |
| AC-12 | 界面 | Where 任何列表为空，界面必须展示空态说明与一个可执行动作 | P0 |
| AC-13 | 告警生命周期 | While 同指纹告警在 30 分钟内重复上报，系统必须只累加 count 与 lastSeen，不新增记录 | P0 |
| AC-14 | 告警生命周期 | If 同指纹告警已 RESOLVED 且超过 30 分钟再次上报，系统必须新建一次发生记录，firstSeen 重置为本次时间 | P0 |
| AC-15 | 跨窗口 | While 同一设备簇告警持续超过一个 5 分钟窗口，系统必须沿用同一 Incident 并延长 lastSeen | P0 |
| AC-16 | 并发故障 | When 两个故障簇拓扑距离 > 2 跳且时间窗重叠，系统必须生成 2 个 Incident，不得合并 | P0 |
| AC-17 | 聚合幂等 | If 同一批数据重复执行聚合，系统必须返回 id 级完全一致的事件集合 | P0 |
| AC-18 | 证据相关性 | If 假设引用的告警设备既不在事件设备集、拓扑距离又 > 2 跳，系统必须剔除该证据 | P0 |
| AC-19 | 压缩比 | While 使用 5 套固定剧本，告警压缩比必须 ≥ 8:1，且标注根因的告警误抑制率必须为 0 | P0 |
| AC-20 | 空结论 | If 全部假设均未通过 L1/L2 校验，系统必须返回空假设 + missingInfo，不得展示编造结论 | P0 |

---

## 20. 变更记录

| 日期 | 版本 | 变更 | 原因 |
|---|---|---|---|
| 2026-11-19 | v0.1 | 首版框架总纲，方向由"威胁情报研判"调整为"网络故障研判" | 用户需求变更 |
| 2026-11-19 | v0.2 | P0 收缩为 7 项纵向切片；Alert 拆为指纹/发生两表；新增 4.2 事件边界 B1–B9；校验器升级为 L1/L2/L3；评测扩至 24 场景并 dev/test 分离；任务卡 10→9；里程碑重排为 14+2 天 | 吸收外部评审意见 |

---

## 21. 评审响应（对 `docs/PROJECT-REVIEW.md` 的逐条处理）

| # | 评审意见 | 结论 | 落点 |
|---|---|---|---|
| 1 | P0 范围仍然偏大，F1–F9 已是完整产品 | **接受**（最影响成败的一条） | 2.1 收缩为 7 项闭环切片；拓扑编辑/SSE/案例推荐降 P1；任务卡 9 张，14+2 天 |
| 2 | "告警数下降 90%" 缺可执行定义 | **接受** | 1 改为压缩比 ≥ 8:1 + 根因告警误抑制率 = 0，写进 AC-19 |
| 3 | 聚合难点在事件边界，不在公式 | **接受** | 新增 4.2 B1–B9：无向聚合/有向归因、单归属、合并、跨窗、并发、幂等、父告警晚到 |
| 4 | `Alert.fingerprint @unique` 存在时间语义风险 | **接受（原设计的实际缺陷）** | 8 拆为 `AlertFingerprint` + `Alert(cycleStart)`；4.3 定义周期与重开规则；AC-13/14 兜底 |
| 5 | 评测集太小，易得虚假高分 | **接受** | 10.5 扩至 24 场景（正例/干扰/对抗各 8），dev 16 + test 8 分离，只报 test 分 |
| 6 | "证据校验" 被误解为反幻觉已解决 | **接受** | 10.3 改为三级校验并显式声明能力边界；新增"证据相关率"指标 |
| 7 | 建议第一版砍掉拓扑完整 CRUD | **部分接受** | 编辑能力降 P1，但**保留只读拓扑 + 影响设备高亮**——它是"影响面"的唯一视觉载体，砍了整个 demo 会失去说服力 |
| 8 | 建议 SSE 后置 | **接受** | MVP-0 用轮询，接口按 SSE 设计，P1 替换不返工 |
| 9 | 建议案例相似推荐后置 | **接受** | MVP-0 只做关键词检索，`CaseRecord` 表结构先立住 |
| 10 | "下一步不应继续扩充文档" | **接受，且执行** | 本轮只做收缩式修订；不再拆 5 份文档，PRD/架构内容以本文档为准，仅额外产出 `AGENT-TASKS.md` + `STATE.md`，然后直接进 T01 |

唯一保留的分歧写在 7：评审把"拓扑"整体判为外围，我判断应该分两半——**编辑是外围，可视化是核心**。理由是根因结论的说服力一半来自"这条链路连着哪些设备"，纯表格看不出影响面。

---

## 附：下一步

1. 确认 v0.2 范围（2.1 的 7 项 + 4.2 的边界规则 + 拆表方案）。
2. 立刻落 T01：仓库骨架 + Prisma + `/api/health` + CI，跑通 `build`。
3. T01 通过后按 T02→T09 顺序推进，每张卡结束更新 `STATE.md`，不再中途改文档。
4. M2 结束跑第一次评测（dev 集），M3 结束跑 test 集，用数据决定 P1 砍哪些。
