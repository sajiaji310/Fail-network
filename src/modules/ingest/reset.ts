import { db } from '@/lib/db';

/**
 * 演示数据清理：只删"注入/聚合产生"的数据，不动 seed 的设备、链路、历史事件与案例。
 *
 * 为什么需要它：5 套剧本的告警都落在同一时间段，连在一起注入时按 B7 的 2 跳规则
 * 会合法地并成一个 mega 事件（见 docs/STATE.md「已知行为」）。逐套验收前必须先清场。
 *
 * 放在 modules 而不是 scripts：CLI 与 `POST /ingest/simulate {reset:true}`
 * 都要用它，scripts 不该被 src 反向依赖。
 */
export type ResetSummary = { alerts: number; incidents: number; changes: number };

export async function resetDemoData(): Promise<ResetSummary> {
  // 告警全部来自注入/导入（seed 不产告警），所以整表清；
  // 事件只删聚合出来的那些，seed 的 30 条历史事件（clusterKey 为空）必须保留
  const [alerts, incidents, changes] = await db.$transaction([
    db.alert.deleteMany({ where: {} }),
    db.incident.deleteMany({ where: { clusterKey: { not: null } } }),
    db.changeRecord.deleteMany({ where: {} }),
  ]);

  return { alerts: alerts.count, incidents: incidents.count, changes: changes.count };
}
