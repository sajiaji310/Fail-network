import { describe, expect, it } from 'vitest';
import {
  CYCLE_GAP_MS,
  decideCycle,
  maxSeverity,
  toCycleStart,
  type ActiveOccurrence,
} from './normalize';

const at = (iso: string) => new Date(iso);

function active(overrides: Partial<ActiveOccurrence> = {}): ActiveOccurrence {
  return {
    id: 'alert-1',
    status: 'ACTIVE',
    severity: 'P2',
    count: 1,
    firstSeen: at('2026-11-19T10:00:00Z'),
    lastSeen: at('2026-11-19T10:00:00Z'),
    ...overrides,
  };
}

describe('decideCycle — 4.3 告警生命周期', () => {
  it('没有活跃周期时新建（AC-14 前半段）', () => {
    const d = decideCycle(null, {
      firstSeen: at('2026-11-19T10:00:00Z'),
      lastSeen: at('2026-11-19T10:00:00Z'),
      count: 1,
    });
    expect(d).toEqual({ kind: 'NEW_CYCLE', expireId: null });
  });

  it('30 分钟内重复上报只累加，不新增（AC-13）', () => {
    const d = decideCycle(active({ count: 2 }), {
      firstSeen: at('2026-11-19T10:20:00Z'),
      lastSeen: at('2026-11-19T10:20:00Z'),
      count: 1,
    });
    expect(d.kind).toBe('ACCUMULATE');
    if (d.kind !== 'ACCUMULATE') return;
    expect(d.targetId).toBe('alert-1');
    expect(d.nextCount).toBe(3);
    expect(d.nextLastSeen.toISOString()).toBe('2026-11-19T10:20:00.000Z');
  });

  it('恰好 30 分钟的边界算新周期（≥ 即过期）', () => {
    const d = decideCycle(active(), {
      firstSeen: new Date(at('2026-11-19T10:00:00Z').getTime() + CYCLE_GAP_MS),
      lastSeen: new Date(at('2026-11-19T10:00:00Z').getTime() + CYCLE_GAP_MS),
      count: 1,
    });
    expect(d).toEqual({ kind: 'NEW_CYCLE', expireId: 'alert-1' });
  });

  it('29 分 59 秒仍在同一周期内', () => {
    const d = decideCycle(active(), {
      firstSeen: new Date(at('2026-11-19T10:00:00Z').getTime() + CYCLE_GAP_MS - 1000),
      lastSeen: new Date(at('2026-11-19T10:00:00Z').getTime() + CYCLE_GAP_MS - 1000),
      count: 1,
    });
    expect(d.kind).toBe('ACCUMULATE');
  });

  it('乱序补报（firstSeen 早于 lastSeen）仍归入同一周期，不新开', () => {
    const d = decideCycle(active({ lastSeen: at('2026-11-19T10:05:00Z'), count: 4 }), {
      firstSeen: at('2026-11-19T10:03:00Z'),
      lastSeen: at('2026-11-19T10:03:00Z'),
      count: 1,
    });
    expect(d.kind).toBe('ACCUMULATE');
    if (d.kind !== 'ACCUMULATE') return;
    expect(d.nextCount).toBe(5);
    // lastSeen 不能被更早的时间回退
    expect(d.nextLastSeen.toISOString()).toBe('2026-11-19T10:05:00.000Z');
  });

  it('SUPPRESSED 也是活跃周期，仍可累加', () => {
    const d = decideCycle(active({ status: 'SUPPRESSED', count: 1 }), {
      firstSeen: at('2026-11-19T10:10:00Z'),
      lastSeen: at('2026-11-19T10:10:00Z'),
      count: 2,
    });
    expect(d.kind).toBe('ACCUMULATE');
    if (d.kind !== 'ACCUMULATE') return;
    expect(d.nextCount).toBe(3);
  });
});

describe('辅助规则', () => {
  it('maxSeverity 取更严重的一档', () => {
    expect(maxSeverity('P2', 'P1')).toBe('P1');
    expect(maxSeverity('P0', 'P3')).toBe('P0');
    expect(maxSeverity('P3', 'P3')).toBe('P3');
  });

  it('cycleStart 保留毫秒精度（避免 RESOLVED 同分钟重开时撞唯一键）', () => {
    const input = at('2026-11-19T10:03:47.812Z');
    expect(toCycleStart(input).toISOString()).toBe('2026-11-19T10:03:47.812Z');
    // 必须是副本，不能让调用方与原对象共享引用
    expect(toCycleStart(input)).not.toBe(input);
  });
});
