import { createHash } from 'node:crypto';

/**
 * 告警指纹：稳定定义（设备 + 类型 + 指标），不含任何时间语义。
 * 同一设备同一类告警无论发生多少次，signature 都相同 —— 周期语义由 Alert.cycleStart 承载。
 */
export function signatureOf(deviceId: string, type: string, metric?: string | null): string {
  return createHash('sha1')
    .update(`${deviceId}|${type}|${metric ?? ''}`)
    .digest('hex');
}

/** 事件簇幂等键：排序后的 fingerprintId 列表哈希（B8） */
export function clusterKeyOf(fingerprintIds: readonly string[]): string {
  const sorted = [...new Set(fingerprintIds)].sort();
  return createHash('sha1').update(sorted.join(',')).digest('hex');
}
