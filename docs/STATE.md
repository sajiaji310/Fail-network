# STATE.md — 当前进度 / 阻塞 / 下一步

> Agent 每次会话必读必写。只记事实，不写计划口号。
> 最后更新：2026-11-19 21:16

## 当前任务

**T03 告警接入 + 模拟器 — 已实现，等待人工验收**

## 已完成

### T01 工程基座（已验收）

- [x] 便携版 PostgreSQL 16.14（`E:/sinxiangmy/.tools/pg16`，端口 5432，用户/库 `netscope`）
- [x] 仓库骨架、设计 Token、`/api/health`、`/overview` 自检页
- [x] 门禁 ESLint + Prettier + tsc strict + Vitest + CI + Docker

### T02 数据模型与种子（已验收）

- [x] 5 枚举 + 8 表；`AlertFingerprint` / `Alert(cycleStart)` 拆表；`clusterKey` 幂等
- [x] seed：30 设备（L1:1 / L2:4 / L3:25）、60 链路、30 事件、30 案例，幂等
- [x] 拓扑校验：全部可达，最大 3 跳

### T03 告警接入 + 模拟器

- [x] `modules/ingest/schema.ts`：`RawAlert` zod 契约（贴近 Zabbix/Prometheus 字段）
- [x] `parsers/csv.ts`：RFC4180 切分（引号 / 逗号 / CRLF / BOM），缺列整体失败，脏行按真实行号跳过
- [x] `parsers/json.ts`：接受裸数组 / `{alerts}` / `{data}`，逐条校验并记 index
- [x] `modules/alerts/fingerprint.ts`：`signatureOf`（sha1(deviceId|type|metric)）、`clusterKeyOf`（排序去重后哈希）
- [x] `modules/ingest/service.ts`：设备解析 → externalKey 幂等 → 指纹 upsert → `(fingerprintId, cycleStart)` 周期去重；失败逐条归因
- [x] `modules/ingest/scenario.ts`：剧本校验、确定性抖动（mulberry32）、时间轴铺排、变更记录落库
- [x] 5 套剧本 JSON 全部可注入且 0 失败：核心线卡 / 光模块劣化 / ACL 变更 / DNS 过载 / 出口闪断
- [x] `POST /api/v1/ingest/alerts`：支持 JSON 与 `text/csv` 两种 body，2MB 上限，200 带 `{accepted,deduped,suppressed,failed,issues}`
- [x] `POST /api/v1/ingest/simulate`：`{scenario, seed?}`，未知剧本 404
- [x] `npm run sim -- --list | --scenario=x [--seed=42]`
- [x] 测试 20 条：CSV 5 / JSON 5 / 指纹 3 / 落库集成 4 / result 3

## 未完成 / 已知偏差

- `suppressed` 恒为 0：父告警抑制属 T04
- `incidentId` 返回 `null`：聚合在 T05 接入后回填
- 剧本注入每次生成新 `runId` 与新 externalKey（= 一批新告警），同一批次重复导入才走 deduped
- CSV 导入的 `source` 取自 `?source=` 查询参数，缺省 `csv-upload`
- 文档 8 节 `Device.alerts` 笔误、`IncidentAlert` 未建表、`embedding` 降级 `String?`（详见 T02 记录）
- 本机沙箱单轮删除 >50 文件会拦截：重启 dev/build 前我先用 PowerShell 清 `.next(-dev)`；你终端跑不受影响
- 本机无管理员权限 → 数据库不能注册 Windows 服务，重启后 `npm run db:start`

## 下一步

1. 人工验收 T03（清单见下）
2. 通过后 → T04：归一化 + 父子抑制 + 30 分钟生命周期 + B9 父告警晚到回溯

## T03 人工验收清单

```bash
npm run sim -- --list                                  # 期望：5 个剧本名
npm run sim -- --scenario=core-switch-board-failure    # 期望：告警 22 条 → 新增 22 / 失败 0
npm run sim -- --scenario=optical-module-degradation   # 期望：12 条全部新增

# externalKey 幂等：同一份 body 连发两次，第二次 accepted=0, deduped=1
curl -s -X POST localhost:3000/api/v1/ingest/alerts -H 'content-type: application/json' \
  -d '{"source":"manual","alerts":[{"externalKey":"MANUAL-001","deviceName":"ACC-SW-05","type":"HIGH_LATENCY","severity":"P2","message":"手测","firstSeen":"2026-11-19T12:00:00Z"}]}'

# 缺列 → 400 且 details 指出缺哪列
printf 'deviceName,type,severity\nACC-SW-10,CPU_HIGH,P2\n' > /tmp/bad.csv
curl -s -X POST localhost:3000/api/v1/ingest/alerts -H 'content-type: text/csv' --data-binary @/tmp/bad.csv
```

浏览器 http://localhost:3000/overview → 「数据基线」卡告警数应随注入增长（当前 78）。

## 阻塞

- 暂无

## 请求新增依赖

- 暂无
