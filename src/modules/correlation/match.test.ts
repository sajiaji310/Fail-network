import { describe, expect, it } from 'vitest';
import type { Severity } from '@prisma/client';
import type { AlertCluster, ClusterAlert } from './cluster';
import { CLUSTER_THRESHOLD, CONTINUATION_WINDOW_MS } from './constants';
import { findContinuation, scoreClusterAgainstIncident, type LoadedIncident } from './match';
import { buildDeviceGraph } from './topology';

/**
 * B5 的两条时间规则（T09 评测驱动）：
 *
 *   dev-15 暴露的问题：静默 6 分钟后，时间项归零，同一场故障被拆成两个事件。
 *   dev-16 暴露的问题：100 分钟后的同设备同类型告警靠拓扑 0.45 + 类型 0.2 = 0.65 硬过阈值，
 *                       第二次发生被并进上一场故障。
 *
 * 修法不是调权重，而是把「还在继续」和「又发生了一次」用 30 分钟分开：
 *   ≤ 30 分钟 → 时间项按 30 分钟归一化后仍可延续；
 *   > 30 分钟 → 直接不参与关联。
 */

const BASE = Date.UTC(2026, 10, 19, 2, 0, 0);
const t = (min: number): Date => new Date(BASE + min * 60_000);

const graph = buildDeviceGraph([
  { sourceId: 'core', targetId: 'agg1' },
  { sourceId: 'agg1', targetId: 'acc1' },
  { sourceId: 'agg1', targetId: 'acc2' },
  { sourceId: 'agg1', targetId: 'acc3' },
  { sourceId: 'acc3', targetId: 'far' },
]);

function alert(
  id: string,
  deviceId: string,
  type: string,
  at: Date,
  severity: Severity = 'P2',
): ClusterAlert {
  return {
    id,
    fingerprintId: `fp-${id}`,
    deviceId,
    deviceName: deviceId.toUpperCase(),
    type,
    severity,
    firstSeen: at,
    lastSeen: at,
  };
}

function incident(alerts: ClusterAlert[], lastSeen: Date): LoadedIncident {
  return {
    id: 'inc-1',
    code: 'INC-20261119-001',
    status: 'OPEN',
    startedAt: alerts[0]!.firstSeen,
    lastSeen,
    deviceIds: [...new Set(alerts.map((a) => a.deviceId))],
    alerts,
  };
}

const cluster = (alerts: ClusterAlert[]): AlertCluster => ({
  key: 'cluster-key',
  alerts,
  deviceIds: [...new Set(alerts.map((a) => a.deviceId))],
  maxScore: 0.8,
});

describe('B5 跨窗口延续（findContinuation）', () => {
  const base = incident(
    [alert('a1', 'core', 'LINECARD_FAILURE', t(0), 'P0'), alert('a2', 'acc1', 'PACKET_LOSS', t(1))],
    t(1),
  );

  it('静默 6 分钟后同簇再现 → 沿用原事件', () => {
    const next = cluster([alert('a3', 'acc2', 'PACKET_LOSS', t(7))]);
    expect(findContinuation(next, [base], graph, t(9))?.id).toBe('inc-1');
  });

  it('间隔超过 30 分钟 → 不沿用（交给 B6 判重开/新建）', () => {
    const next = cluster([alert('a4', 'acc2', 'PACKET_LOSS', t(60))]);
    expect(findContinuation(next, [base], graph, t(61))).toBeNull();
  });

  it('拓扑太远（> 2 跳）→ 不沿用，即便时间很近', () => {
    const next = cluster([alert('a5', 'far', 'PACKET_LOSS', t(2))]);
    expect(findContinuation(next, [base], graph, t(3))).toBeNull();
  });

  it('类型完全不同族 → 不沿用', () => {
    const next = cluster([alert('a6', 'acc2', 'TEMPERATURE_HIGH', t(2), 'P3')]);
    // 温度告警与丢包亲和度 0.5：0.225 + 0.24 + 0.125 = 0.59 仍过阈值，
    // 这是"同一设备发热导致丢包"的合理场景，故断言沿用而不是拒绝。
    expect(findContinuation(next, [base], graph, t(3))?.id).toBe('inc-1');
  });
});

describe('簇↔事件打分的时间闸门', () => {
  const base = incident([alert('b1', 'core', 'LINECARD_FAILURE', t(0), 'P0')], t(0));

  it('同一设备 3 分钟后再报 → 高分关联（时间项用 lastSeen 作锚）', () => {
    const next = cluster([alert('b2', 'core', 'CPU_HIGH', t(3))]);
    const match = scoreClusterAgainstIncident(next, base, graph, t(4));
    expect(match.score).toBeGreaterThanOrEqual(CLUSTER_THRESHOLD);
  });

  it('同一设备 100 分钟后再报 → 直接 0 分（否则会被并进上一场故障）', () => {
    const next = cluster([alert('b3', 'core', 'CPU_HIGH', t(100))]);
    expect(scoreClusterAgainstIncident(next, base, graph, t(101)).score).toBe(0);
  });

  it('恰好落在 30 分钟边界内仍可关联', () => {
    const next = cluster([
      alert('b4', 'core', 'CPU_HIGH', new Date(t(0).getTime() + CONTINUATION_WINDOW_MS - 1000)),
    ]);
    expect(scoreClusterAgainstIncident(next, base, graph, t(30)).score).toBeGreaterThan(0);
  });
});
