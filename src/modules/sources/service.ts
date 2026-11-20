import { db } from '@/lib/db';
import { listBatches, type BatchView } from '@/modules/ingest/batch';

/**
 * 数据源接入页的读模型。
 *
 * 这个页面回答三个现实问题：
 * 1. "我把 Prometheus 指到哪个地址？" → ENDPOINTS
 * 2. "为什么我的告警全落到设备不存在？" → 设备别名表
 * 3. "上一批 3 万条跑到哪了？" → 批次列表
 *
 * 它不做配置编辑：接哪个数据源、用什么 Key 属于部署决策，写进 `.env` 比写进页面
 * 更不容易出现"页面显示连了、进程里没连"的双份事实。
 */

export type EndpointDoc = {
  kind: string;
  label: string;
  method: 'POST';
  path: string;
  /** 一行 curl，够复制就能验证通不通 */
  sample: string;
  note: string;
};

export const ENDPOINTS: EndpointDoc[] = [
  {
    kind: 'alertmanager',
    label: 'Prometheus Alertmanager',
    method: 'POST',
    path: '/api/v1/ingest/alertmanager?source=prod-am',
    sample: `curl -sS -X POST 'http://localhost:3000/api/v1/ingest/alertmanager?source=prod-am' \\
  -H 'content-type: application/json' -H 'x-api-key: $API_KEY' \\
  -d '{"version":"4","status":"firing","alerts":[{"status":"firing","labels":{"alertname":"InterfaceDown","instance":"CORE-SW-01:9100","severity":"critical"},"annotations":{"summary":"Gi0/1 link down"},"startsAt":"2026-11-20T10:00:00Z","fingerprint":"demo-1"}]}'`,
    note: '已恢复（resolved）的告警会被跳过并计入 skipped；instance 的端口号自动剥掉。',
  },
  {
    kind: 'zabbix',
    label: 'Zabbix',
    method: 'POST',
    path: '/api/v1/ingest/zabbix?source=zbx-prod',
    sample: `curl -sS -X POST 'http://localhost:3000/api/v1/ingest/zabbix?source=zbx-prod' \\
  -H 'content-type: application/json' -H 'x-api-key: $API_KEY' \\
  -d '{"host":"CORE-SW-01","trigger":"Interface Gi0/1 link down","severity":4,"eventid":"10086","clock":1763625600}'`,
    note: '同时接受 {problems:[...]} 与裸数组；severity 支持 0–5 与 High/Disaster 文本。',
  },
  {
    kind: 'metrics',
    label: '指标采样',
    method: 'POST',
    path: '/api/v1/metrics/samples',
    sample: `curl -sS -X POST 'http://localhost:3000/api/v1/metrics/samples' \\
  -H 'content-type: application/json' -H 'x-api-key: $API_KEY' \\
  -d '{"samples":[{"deviceName":"CORE-SW-01","metric":"cpu.util","value":78.5,"unit":"%","at":"2026-11-20T10:00:00Z"}]}'`,
    note: '同一设备同一指标同一时刻同一来源只留一条，上游重推不会把曲线拉高。',
  },
];

export type AliasRow = {
  id: string;
  alias: string;
  deviceName: string;
  source: string;
  createdAt: string;
};

export type SourceOverview = {
  endpoints: EndpointDoc[];
  aliases: AliasRow[];
  /** 供别名录入的下拉选项 */
  devices: { id: string; name: string }[];
  batches: BatchView[];
  stats: {
    devices: number;
    aliasedDevices: number;
    aliases: number;
    /** 最近一批的接收量，给人一个"接进来了没有"的量级感 */
    lastBatchAt: string | null;
  };
};

export async function getSourceOverview(tenantId = 'default'): Promise<SourceOverview> {
  const [devices, deviceOptions, aliasedGroups, aliasCount, aliasRows, batches] = await Promise.all(
    [
      db.device.count({ where: { tenantId } }),
      db.device.findMany({
        where: { tenantId },
        orderBy: [{ layer: 'asc' }, { name: 'asc' }],
        take: 200,
        select: { id: true, name: true },
      }),
      db.deviceAlias.groupBy({
        by: ['deviceId'],
        where: { device: { tenantId } },
        _count: { _all: true },
      }),
      db.deviceAlias.count({ where: { device: { tenantId } } }),
      db.deviceAlias.findMany({
        where: { device: { tenantId } },
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: {
          id: true,
          alias: true,
          source: true,
          createdAt: true,
          device: { select: { name: true } },
        },
      }),
      listBatches(tenantId, 10),
    ],
  );

  return {
    endpoints: ENDPOINTS,
    devices: deviceOptions,
    aliases: aliasRows.map((row) => ({
      id: row.id,
      alias: row.alias,
      deviceName: row.device.name,
      source: row.source,
      createdAt: row.createdAt.toISOString(),
    })),
    batches,
    stats: {
      devices,
      aliasedDevices: aliasedGroups.length,
      aliases: aliasCount,
      lastBatchAt: batches[0]?.createdAt.toISOString() ?? null,
    },
  };
}
