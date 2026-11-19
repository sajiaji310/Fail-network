import { describe, expect, it } from 'vitest';
import { clusterKeyOf } from '../alerts/fingerprint';
import { clusterAlerts, type ClusterAlert } from './cluster';
import { CLUSTER_WINDOW_MS } from './constants';
import { buildDeviceGraph } from './topology';

/**
 * 拓扑：core—agg，agg—acc1，acc1—acc2
 * core 到 acc2 是 3 跳，用来验证 B7 的 2 跳闸门。
 */
const graph = buildDeviceGraph([
  { sourceId: 'core', targetId: 'agg' },
  { sourceId: 'agg', targetId: 'acc1' },
  { sourceId: 'acc1', targetId: 'acc2' },
]);

const T0 = new Date('2026-11-19T10:00:00Z');
let seq = 0;

function alert(
  deviceId: string,
  type: string,
  offsetMs = 0,
  overrides: Partial<ClusterAlert> = {},
): ClusterAlert {
  seq++;
  const at = new Date(T0.getTime() + offsetMs);
  return {
    id: `a${seq}`,
    fingerprintId: `fp-${deviceId}-${type}`,
    deviceId,
    deviceName: deviceId.toUpperCase(),
    type,
    severity: 'P2',
    firstSeen: at,
    lastSeen: at,
    ...overrides,
  };
}

describe('聚类（AC-03 / AC-16 / B7）', () => {
  it('同设备 3 条 5 分钟内 → 1 个簇（AC-03）', () => {
    const clusters = clusterAlerts(
      [
        alert('acc1', 'LINK_DOWN', 0),
        alert('acc1', 'PACKET_LOSS', 60_000),
        alert('acc1', 'CPU_HIGH', 120_000),
      ],
      graph,
    );
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.alerts).toHaveLength(3);
  });

  it('同设备但相隔 10 分钟 → 拆成 3 个单点簇（滑窗硬边界）', () => {
    const clusters = clusterAlerts(
      [
        alert('acc1', 'LINK_DOWN', 0),
        alert('acc1', 'PACKET_LOSS', 10 * 60_000),
        alert('acc1', 'CPU_HIGH', 20 * 60_000),
      ],
      graph,
    );
    expect(clusters).toHaveLength(3);
    expect(clusters.every((c) => c.alerts.length === 1)).toBe(true);
  });

  it('3 跳外的两个同类型告警不合并，即使时间完全重叠（B7 / AC-16）', () => {
    const clusters = clusterAlerts(
      [
        alert('core', 'LINK_DOWN', 0),
        alert('core', 'LINK_DOWN', 30_000),
        alert('core', 'LINK_DOWN', 60_000),
        alert('acc2', 'LINK_DOWN', 0),
        alert('acc2', 'LINK_DOWN', 30_000),
        alert('acc2', 'LINK_DOWN', 60_000),
      ],
      graph,
    );
    expect(clusters).toHaveLength(2);
    expect(
      clusters
        .map((c) => c.deviceIds)
        .flat()
        .sort(),
    ).toEqual(['acc2', 'core']);
  });

  it('两跳内跨设备会合并（core 与 acc1 相邻两跳）', () => {
    const clusters = clusterAlerts(
      [alert('core', 'LINK_DOWN', 0), alert('agg', 'LINK_DOWN', 60_000)],
      graph,
    );
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.alerts).toHaveLength(2);
  });

  it('单条告警也返回簇，但不由聚类决定是否成事件', () => {
    const clusters = clusterAlerts([alert('acc1', 'CPU_HIGH')], graph);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.alerts).toHaveLength(1);
    expect(clusters[0]!.maxScore).toBe(0);
  });
});

describe('聚类确定性（AC-17 基础）', () => {
  it('输入顺序打乱后，簇的 key 集合完全一致', () => {
    const nodes = [
      alert('acc1', 'LINK_DOWN', 0),
      alert('acc1', 'PACKET_LOSS', 30_000),
      alert('acc1', 'CPU_HIGH', 60_000),
      alert('acc2', 'LINK_DOWN', 0),
      alert('acc2', 'PACKET_LOSS', 30_000),
      alert('acc2', 'CPU_HIGH', 60_000),
    ];
    const forward = clusterAlerts(nodes, graph).map((c) => c.key);
    const backward = clusterAlerts([...nodes].reverse(), graph).map((c) => c.key);
    expect(backward).toEqual(forward);
  });

  it('簇 key 等于排序后指纹集合的 sha1（B8）', () => {
    const nodes = [
      alert('acc1', 'LINK_DOWN', 0),
      alert('acc1', 'PACKET_LOSS', 60_000),
      alert('acc1', 'CPU_HIGH', 120_000),
    ];
    const [cluster] = clusterAlerts(nodes, graph);
    expect(cluster!.key).toBe(clusterKeyOf(nodes.map((n) => n.fingerprintId)));
  });
});

describe('性能（AC-11 内存部分）', () => {
  it('500 条告警聚类 < 500ms', () => {
    const nodes: ClusterAlert[] = [];
    for (let i = 0; i < 500; i++) {
      // 均匀铺在 30 台虚拟设备上，时间跨度约 33 分钟，制造大量真实候选对
      nodes.push(alert(`d${i % 30}`, ['LINK_DOWN', 'PACKET_LOSS', 'CPU_HIGH'][i % 3]!, i * 4_000));
    }
    const chain = buildDeviceGraph(
      Array.from({ length: 29 }, (_, i) => ({ sourceId: `d${i}`, targetId: `d${i + 1}` })),
    );

    const start = performance.now();
    const clusters = clusterAlerts(nodes, chain);
    const elapsed = performance.now() - start;

    expect(clusters.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(500);
  });

  it('时间窗常量与文档一致', () => {
    expect(CLUSTER_WINDOW_MS).toBe(5 * 60 * 1000);
  });
});
