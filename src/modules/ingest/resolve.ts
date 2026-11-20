import { db } from '@/lib/db';

/**
 * 告警里的"设备是谁" —— 真实数据源接入的关键一步。
 *
 * 三种标识都要认，且有明确优先级：
 *   1. 别名（DeviceAlias）：`core-sw-01.lab` / `10.1.0.1:9100` 这类上游写法
 *   2. 设备名：与 CMDB 完全一致的情况
 *   3. 设备 IP：Prometheus 的 instance 剥掉端口后正好是设备地址
 *
 * 为什么一次把租户内设备全取回来做内存匹配，而不是按名 `IN` 查询：
 * 设备表是**配置数据**，量级在几百到几千，一次查询 + 内存匹配比"先按名查、
 * 匹配不到再按 IP 查、再按别名查"的三轮往返更简单也更快，而且能顺带做大小写不敏感。
 * 如果设备量级上万，这里要改成分批 IN 查询 —— 注释留在这里，避免后人直接照抄。
 */

export type DeviceRef = { id: string; name: string };
export type DeviceLookup = {
  alias: Map<string, DeviceRef>;
  name: Map<string, DeviceRef>;
  ip: Map<string, DeviceRef>;
};

function key(value: string): string {
  return value.trim().toLowerCase();
}

export async function loadDevices(tenantId = 'default'): Promise<DeviceLookup> {
  const devices = await db.device.findMany({
    where: { tenantId },
    select: { id: true, name: true, ip: true, aliases: { select: { alias: true } } },
  });

  const lookup: DeviceLookup = { alias: new Map(), name: new Map(), ip: new Map() };
  for (const device of devices) {
    const ref: DeviceRef = { id: device.id, name: device.name };
    lookup.name.set(key(device.name), ref);
    if (device.ip) lookup.ip.set(key(device.ip), ref);
    for (const alias of device.aliases) lookup.alias.set(key(alias.alias), ref);
  }
  return lookup;
}

/** 按 别名 → 设备名 → IP 的顺序解析；解析不到返回 null（调用方记 issue） */
export function findDevice(lookup: DeviceLookup, rawName: string): DeviceRef | null {
  const k = key(rawName);
  return lookup.alias.get(k) ?? lookup.name.get(k) ?? lookup.ip.get(k) ?? null;
}
