import { db } from '@/lib/db';

/**
 * 业务影响面（评审第 3 阶段「增加服务影响面和业务依赖」）。
 *
 * 口径：**受影响服务 = 事件设备 ∩ 服务依赖设备**，现算不落库。
 * 理由和拓扑完整度一样 —— 事件与服务的关联是派生事实，存下来就要处理
 * "服务改了依赖、事件要不要重算"的一致性问题，而这张表小到可以每次现算。
 *
 * 只报"哪几个业务受影响"，不推断"影响多少用户"：后者需要真实业务量数据，
 * 靠设备数乘系数编出来的数字在复盘会上站不住脚。
 */

export type AffectedService = {
  id: string;
  code: string;
  name: string;
  tier: number;
  owner: string | null;
  note: string | null;
  /** 命中的设备名，供页面直接展示"因为哪几台设备被波及" */
  hitDevices: string[];
  roles: string[];
};

export const SERVICE_TIER_LABEL: Record<number, string> = {
  1: '关键',
  2: '重要',
  3: '一般',
};

type ServiceDeviceRow = {
  role: string | null;
  device: { id: string; name: string };
  service: {
    id: string;
    code: string;
    name: string;
    tier: number;
    owner: string | null;
    note: string | null;
  };
};

function group(rows: readonly ServiceDeviceRow[]): AffectedService[] {
  const byService = new Map<string, AffectedService>();
  for (const row of rows) {
    let item = byService.get(row.service.id);
    if (!item) {
      item = {
        id: row.service.id,
        code: row.service.code,
        name: row.service.name,
        tier: row.service.tier,
        owner: row.service.owner,
        note: row.service.note,
        hitDevices: [],
        roles: [],
      };
      byService.set(row.service.id, item);
    }
    if (!item.hitDevices.includes(row.device.name)) item.hitDevices.push(row.device.name);
    if (row.role && !item.roles.includes(row.role)) item.roles.push(row.role);
  }
  // 关键业务排前面，同级按编码固定顺序 —— 值班时第一眼先看影响面最大的
  return [...byService.values()].sort((a, b) => a.tier - b.tier || a.code.localeCompare(b.code));
}

export async function getAffectedServices(
  deviceIds: readonly string[],
): Promise<AffectedService[]> {
  if (deviceIds.length === 0) return [];
  const rows = await db.serviceDevice.findMany({
    where: { deviceId: { in: [...deviceIds] } },
    select: {
      role: true,
      device: { select: { id: true, name: true } },
      service: {
        select: { id: true, code: true, name: true, tier: true, owner: true, note: true },
      },
    },
  });
  return group(rows);
}

/**
 * 批量版：概览页一次查询覆盖整页事件，避免每个事件一次往返。
 * 返回 deviceId → 受影响服务列表（同一服务可能因多台设备命中而合并）。
 */
export async function mapAffectedServicesByDevice(
  deviceIds: readonly string[],
): Promise<Map<string, AffectedService[]>> {
  const result = new Map<string, AffectedService[]>();
  if (deviceIds.length === 0) return result;

  const rows = await db.serviceDevice.findMany({
    where: { deviceId: { in: [...deviceIds] } },
    select: {
      role: true,
      device: { select: { id: true, name: true } },
      service: {
        select: { id: true, code: true, name: true, tier: true, owner: true, note: true },
      },
    },
  });

  const byDevice = new Map<string, ServiceDeviceRow[]>();
  for (const row of rows) {
    const list = byDevice.get(row.device.id) ?? [];
    list.push(row);
    byDevice.set(row.device.id, list);
  }
  for (const [deviceId, list] of byDevice) result.set(deviceId, group(list));
  return result;
}

/** 事件级汇总：把多台设备的服务合并去重（概览行只显示服务数量与关键服务） */
export function mergeServices(lists: readonly AffectedService[][]): AffectedService[] {
  const byId = new Map<string, AffectedService>();
  for (const list of lists) {
    for (const item of list) {
      const existing = byId.get(item.id);
      if (!existing) {
        byId.set(item.id, { ...item, hitDevices: [...item.hitDevices], roles: [...item.roles] });
        continue;
      }
      for (const d of item.hitDevices)
        if (!existing.hitDevices.includes(d)) existing.hitDevices.push(d);
      for (const r of item.roles) if (!existing.roles.includes(r)) existing.roles.push(r);
    }
  }
  return [...byId.values()].sort((a, b) => a.tier - b.tier || a.code.localeCompare(b.code));
}
