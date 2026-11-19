import { describe, expect, it } from 'vitest';
import { checkMergeable, intervalOverlapRatio, type MergeCandidate } from './merge';
import { buildDeviceGraph } from './topology';

const graph = buildDeviceGraph([
  { sourceId: 'A', targetId: 'B' },
  { sourceId: 'B', targetId: 'C' },
  { sourceId: 'C', targetId: 'D' },
]);

const T0 = new Date('2026-11-19T10:00:00Z').getTime();
const min = (n: number) => new Date(T0 + n * 60_000);

function incident(overrides: Partial<MergeCandidate>): MergeCandidate {
  return {
    id: 'i1',
    code: 'INC-20261119-001',
    startedAt: min(0),
    lastSeen: min(30),
    deviceIds: ['A', 'B'],
    ...overrides,
  };
}

describe('时间重叠比例', () => {
  it('完全重合为 1，完全不交为 0', () => {
    expect(intervalOverlapRatio(min(0), min(10), min(0), min(10))).toBe(1);
    expect(intervalOverlapRatio(min(0), min(10), min(20), min(30))).toBe(0);
  });

  it('半重叠按 Jaccard 计算', () => {
    expect(intervalOverlapRatio(min(0), min(10), min(5), min(10))).toBeCloseTo(0.5, 5);
  });

  it('瞬时事件同刻算完全重叠', () => {
    expect(intervalOverlapRatio(min(0), min(0), min(0), min(0))).toBe(1);
  });
});

describe('B3 合并判定', () => {
  it('共享 2 台设备 + 时间重叠 > 50% + 2 跳内 → 允许合并', () => {
    const check = checkMergeable(
      incident({ id: 'a', deviceIds: ['A', 'B'] }),
      incident({ id: 'b', deviceIds: ['A', 'B', 'C'] }),
      graph,
    );
    expect(check.ok).toBe(true);
    expect(check.sharedDevices).toBe(2);
  });

  it('只共享 1 台设备 → 拒绝', () => {
    const check = checkMergeable(
      incident({ id: 'a', deviceIds: ['A'] }),
      incident({ id: 'b', deviceIds: ['A', 'C'] }),
      graph,
    );
    expect(check.ok).toBe(false);
    expect(check.reason).toBe('SHARED_DEVICES_TOO_FEW');
  });

  it('3 跳外 → B7 强制拒绝，即使时间完全重叠', () => {
    const check = checkMergeable(
      incident({ id: 'a', deviceIds: ['A'] }),
      incident({ id: 'b', deviceIds: ['D'] }),
      graph,
    );
    expect(check.ok).toBe(false);
    expect(check.reason).toBe('TOPOLOGY_TOO_FAR');
  });

  it('时间几乎不重叠 → 拒绝', () => {
    const check = checkMergeable(
      incident({ id: 'a', deviceIds: ['A', 'B'], startedAt: min(0), lastSeen: min(10) }),
      incident({ id: 'b', deviceIds: ['A', 'B'], startedAt: min(60), lastSeen: min(70) }),
      graph,
    );
    expect(check.ok).toBe(false);
    expect(check.reason).toBe('TIME_OVERLAP_TOO_LOW');
  });
});
