import { handleWebhook } from '@/modules/ingest/webhook';

export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/ingest/zabbix — Zabbix media type webhook 接收端。
 *
 * 支持三种请求体：单条事件对象、`{problems:[...]}`、裸数组。
 * Zabbix 侧把 media type 的脚本指到本地址即可，字段名差异由适配器收敛。
 */
export async function POST(req: Request) {
  return handleWebhook(req, 'zabbix');
}
