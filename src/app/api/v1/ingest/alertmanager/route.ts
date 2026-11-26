import { handleWebhook } from '@/modules/ingest/webhook';

export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/ingest/alertmanager — Prometheus Alertmanager webhook 接收端。
 *
 * Alertmanager 侧配置（`alertmanager.yml`）：
 * ```yaml
 * receivers:
 *   - name: netscope
 *     webhook_configs:
 *       - url: 'http://netscope:3000/api/v1/ingest/alertmanager?source=prod-am'
 *         send_resolved: true   # 恢复通知会按 fingerprint + startsAt 关闭已有周期
 * ```
 */
export async function POST(req: Request) {
  return handleWebhook(req, 'alertmanager');
}
