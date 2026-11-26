import { describe, expect, it } from 'vitest';
import { classifyAlertType, type AlertClass } from '@/modules/alerts/taxonomy';
import { familyOf } from '@/modules/correlation/affinity';
import {
  attributionTag,
  buildDeviceSignals,
  categoryOfType,
  isExplainedType,
} from './explainability';
import { makeContext } from './test-utils';
import type { HypothesisCategory } from './schema';

/**
 * 归因本体抽离的等值锁（Spec 0.2 §3.1「行为必须逐字不变」）。
 *
 * 断言方式：把抽取前 `fallback.ts` 的两个私有实现原样抄在这里当参照物，
 * 对每一个真实告警类型逐一比对。这不是"测一遍实现"，而是"证明搬家没改语义"——
 * 一旦有人在新文件里顺手优化了映射顺位，这里立刻红。
 */

/** 抽取前 fallback.ts 的 isExplained 原文 */
function legacyIsExplained(type: string): boolean {
  return classifyAlertType(type) !== 'UNKNOWN' || familyOf(type) !== 'OTHER';
}

/** 抽取前 fallback.ts 的 categoryOf 类型映射段原文（change / 无告警两个前置分支不在本函数内） */
function legacyCategoryOf(type: string, alertClass: AlertClass): HypothesisCategory {
  if (alertClass === 'ROOT' || alertClass === 'PARENT') return 'HARDWARE';
  if (type.trim().toUpperCase() === 'DNS_TIMEOUT') return 'UPSTREAM';
  const family = familyOf(type);
  if (family === 'LINK') return 'LINK';
  if (family === 'ROUTING') return 'UPSTREAM';
  if (family === 'RESOURCE') return 'CAPACITY';
  if (family === 'QUALITY') return 'LINK';
  return 'OTHER';
}

/**
 * 全部真实告警类型 = taxonomy 的 32 个（PARENT 5 + ROOT 9 + CHILD 18）
 * 并上只在 affinity 登记的 ROUTE_FLAP。
 */
const REAL_TYPES = [
  // 父告警
  'DEVICE_UNREACHABLE',
  'DEVICE_DOWN',
  'DEVICE_OFFLINE',
  'DEVICE_POWER_FAILURE',
  'AGENT_UNREACHABLE',
  // 设备级根因
  'LINECARD_FAILURE',
  'CHASSIS_FAILURE',
  'SUPERVISOR_FAILURE',
  'FAN_FAILURE',
  'POWER_SUPPLY_FAILURE',
  'MEMORY_FAILURE',
  'DISK_FAILURE',
  'TEMPERATURE_HIGH',
  'VOLTAGE_ABNORMAL',
  // 端口与链路
  'LINK_DOWN',
  'PORT_DOWN',
  'PORT_FLAP',
  'INTERFACE_ERROR',
  'CRC_ERROR',
  'OPTICAL_RX_LOW',
  'OPTICAL_TX_LOW',
  'OPTICAL_MODULE_FAILURE',
  // 邻居与路由
  'BGP_NEIGHBOR_DOWN',
  'OSPF_NEIGHBOR_DOWN',
  'ACL_DENY_HIT',
  'ROUTE_FLAP',
  // 质量指标
  'PACKET_LOSS',
  'HIGH_LATENCY',
  'JITTER_HIGH',
  'DNS_TIMEOUT',
  // 资源指标
  'CPU_HIGH',
  'MEMORY_HIGH',
  'SESSION_HIGH',
] as const;

const UNKNOWN_TYPES = ['UNKNOWN_SENSOR_A', 'SENSOR_TEMP_X', 'test_metric_unregistered'] as const;

const CLASSES: readonly AlertClass[] = ['PARENT', 'ROOT', 'CHILD', 'UNKNOWN'];

describe('isExplainedType 与旧实现等值', () => {
  it.each(REAL_TYPES)('%s 判定与旧实现一致且为 true', (type) => {
    expect(isExplainedType(type)).toBe(legacyIsExplained(type));
    expect(isExplainedType(type)).toBe(true);
  });

  it.each(UNKNOWN_TYPES)('%s 未登记 → false', (type) => {
    expect(isExplainedType(type)).toBe(legacyIsExplained(type));
    expect(isExplainedType(type)).toBe(false);
  });

  it('大小写与空白不影响判定（trim + toUpperCase 口径不变）', () => {
    expect(isExplainedType('  link_down ')).toBe(true);
    expect(isExplainedType('dns_timeout')).toBe(true);
  });
});

describe('categoryOfType 与旧实现等值（全部真实类型 × 4 个告警类别）', () => {
  const cases = REAL_TYPES.flatMap((type) =>
    CLASSES.map((alertClass) => [type, alertClass] as const),
  );

  it.each(cases)('%s / %s', (type, alertClass) => {
    const legacy = legacyCategoryOf(type, alertClass);
    // 旧实现对未登记类型回落 OTHER，新实现返回 null 由调用方决定 —— 兜底值必须仍是 OTHER
    expect(categoryOfType(type, alertClass) ?? 'OTHER').toBe(legacy);
  });

  it('未登记类型返回 null（不猜类别）', () => {
    for (const type of UNKNOWN_TYPES) {
      expect(categoryOfType(type, 'UNKNOWN')).toBeNull();
    }
  });

  it('DNS_TIMEOUT 的特判优先于族的通用映射（QUALITY 族仍归 UPSTREAM）', () => {
    expect(familyOf('DNS_TIMEOUT')).toBe('QUALITY');
    expect(categoryOfType('DNS_TIMEOUT', 'CHILD')).toBe('UPSTREAM');
  });

  it('ROOT / PARENT 一律 HARDWARE，与族无关', () => {
    expect(categoryOfType('LINECARD_FAILURE', 'ROOT')).toBe('HARDWARE');
    expect(categoryOfType('DEVICE_UNREACHABLE', 'PARENT')).toBe('HARDWARE');
  });
});

describe('attributionTag 是提示词可见的标签', () => {
  it('已登记类型输出 category 枚举值', () => {
    const allowed = new Set(['HARDWARE', 'CONFIG', 'LINK', 'CAPACITY', 'UPSTREAM', 'OTHER']);
    for (const type of REAL_TYPES) {
      const tag = attributionTag(type, classifyAlertType(type));
      expect(allowed.has(tag)).toBe(true);
    }
  });

  it('未登记类型输出「未登记」，不猜类别', () => {
    expect(attributionTag('UNKNOWN_SENSOR_A', 'UNKNOWN')).toBe('未登记');
  });

  it('CAPACITY 正例来自资源族', () => {
    expect(attributionTag('CPU_HIGH', 'CHILD')).toBe('CAPACITY');
    expect(attributionTag('SESSION_HIGH', 'CHILD')).toBe('CAPACITY');
  });
});

describe('buildDeviceSignals 只陈述事实', () => {
  const signals = buildDeviceSignals(makeContext());
  const names = signals.map((s) => s.deviceName);

  it('覆盖所有有告警的设备', () => {
    expect(names).toEqual(expect.arrayContaining(['AGG-SW-02', 'ACC-SW-07', 'ACC-SW-11']));
  });

  it('有事件前变更但无告警的设备也在列（ACL 类根因靠这条信号）', () => {
    const core = signals.find((s) => s.deviceName === 'CORE-SW-01');
    expect(core).toBeDefined();
    expect(core?.alertCount).toBe(0);
    expect(core?.hasPrecedingChange).toBe(true);
  });

  it('晚于首个告警的变更不计入 hasPrecedingChange', () => {
    expect(signals.find((s) => s.deviceName === 'AGG-SW-02')?.hasPrecedingChange).toBe(false);
  });

  it('带告警的设备统计条数与去重类型', () => {
    const agg2 = signals.find((s) => s.deviceName === 'AGG-SW-02');
    expect(agg2?.alertCount).toBe(2);
    expect(agg2?.types).toEqual(['LINECARD_FAILURE', 'DEVICE_UNREACHABLE']);
    expect(agg2?.layerLabel).toBe('汇聚层');
  });

  it('不含分数、不含排序字段（B 组消融不能被规则先验污染）', () => {
    for (const signal of signals) {
      expect(Object.keys(signal).sort()).toEqual([
        'alertCount',
        'deviceName',
        'hasPrecedingChange',
        'layerLabel',
        'types',
      ]);
    }
  });
});
