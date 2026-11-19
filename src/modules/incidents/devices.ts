import type { AlertStatus, DeviceType, Severity } from '@prisma/client';

/**
 * 影响面设备聚合（事件详情左/右栏与拓扑高亮都用这份）。
 * 从 detail.ts 抽出来是因为取数函数已经接近 300 行上限，而这段是纯计算，
 * 跟数据库无关，单独放更容易读也更容易测。
 */

export type IncidentDevice = {
  id: string;
  name: string;
  type: DeviceType;
  layer: number;
  site: string | null;
  ip: string | null;
  alertCount: number;
  suppressedCount: number;
  maxSeverity: Severity;
  types: string[];
};

export type DeviceAlertInput = {
  severity: Severity;
  status: AlertStatus;
  type: string;
  device: {
    id: string;
    name: string;
    type: DeviceType;
    layer: number;
    site: string | null;
    ip: string | null;
  };
};

const SEVERITY_RANK: Record<Severity, number> = { P0: 4, P1: 3, P2: 2, P3: 1 };

/** 按层、严重度、名称排序：核心层在最上面，符合"从上往下看"的排障习惯 */
export function aggregateIncidentDevices(rows: readonly DeviceAlertInput[]): IncidentDevice[] {
  const map = new Map<string, IncidentDevice>();

  for (const row of rows) {
    const device = row.device;
    let entry = map.get(device.id);
    if (!entry) {
      entry = {
        id: device.id,
        name: device.name,
        type: device.type,
        layer: device.layer,
        site: device.site,
        ip: device.ip,
        alertCount: 0,
        suppressedCount: 0,
        maxSeverity: row.severity,
        types: [],
      };
      map.set(device.id, entry);
    }
    entry.alertCount += 1;
    if (row.status === 'SUPPRESSED') entry.suppressedCount += 1;
    if (SEVERITY_RANK[row.severity] > SEVERITY_RANK[entry.maxSeverity]) {
      entry.maxSeverity = row.severity;
    }
    if (!entry.types.includes(row.type)) entry.types.push(row.type);
  }

  return [...map.values()].sort(
    (a, b) =>
      a.layer - b.layer ||
      SEVERITY_RANK[b.maxSeverity] - SEVERITY_RANK[a.maxSeverity] ||
      a.name.localeCompare(b.name),
  );
}
