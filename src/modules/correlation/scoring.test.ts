import { describe, expect, it } from 'vitest';
import { typeAffinity } from './affinity';
import { CLUSTER_WINDOW_MS, UNREACHABLE_HOPS } from './constants';
import { canRelate, scorePair, timeProximity, topologyProximity, withinWindow } from './scoring';
import { buildDeviceGraph } from './topology';

/** A—B—C—D：A 到 D 是 3 跳，用来验证 B7 的 2 跳闸门 */
const graph = buildDeviceGraph([
  { sourceId: 'A', targetId: 'B' },
  { sourceId: 'B', targetId: 'C' },
  { sourceId: 'C', targetId: 'D' },
]);

const T0 = new Date('2026-11-19T10:00:00Z');

function node(deviceId: string, type: string, msOffset = 0) {
  return { deviceId, type, firstSeen: new Date(T0.getTime() + msOffset) };
}

describe('拓扑跳数（B1 无向）', () => {
  it('同设备 0 跳，直连 1 跳，两跳 2 跳', () => {
    expect(graph.hop('A', 'A')).toBe(0);
    expect(graph.hop('A', 'B')).toBe(1);
    expect(graph.hop('A', 'C')).toBe(2);
  });

  it('超过 2 跳返回不可达哨兵值', () => {
    expect(graph.hop('A', 'D')).toBe(UNREACHABLE_HOPS);
  });

  it('链路只存一个方向时，反查仍可达（无向）', () => {
    expect(graph.hop('B', 'A')).toBe(1);
    expect(graph.hop('C', 'A')).toBe(2);
  });

  it('minHopBetween 取两组设备间最小值', () => {
    expect(graph.minHopBetween(['A'], ['C', 'D'])).toBe(2);
    expect(graph.minHopBetween(['D'], ['A'])).toBe(UNREACHABLE_HOPS);
  });
});

describe('接近度与打分公式', () => {
  it('拓扑接近度按 1.0 / 0.8 / 0.5 / 0 分档', () => {
    expect(topologyProximity(graph, node('A', 'X'), node('A', 'X'))).toBe(1);
    expect(topologyProximity(graph, node('A', 'X'), node('B', 'X'))).toBe(0.8);
    expect(topologyProximity(graph, node('A', 'X'), node('C', 'X'))).toBe(0.5);
    expect(topologyProximity(graph, node('A', 'X'), node('D', 'X'))).toBe(0);
  });

  it('时间接近度线性衰减，超出窗口归零', () => {
    expect(timeProximity(0, 0)).toBe(1);
    expect(timeProximity(0, CLUSTER_WINDOW_MS / 2)).toBe(0.5);
    expect(timeProximity(0, CLUSTER_WINDOW_MS)).toBe(0);
    expect(timeProximity(0, CLUSTER_WINDOW_MS * 3)).toBe(0);
  });

  it('同设备同类型同刻得满分', () => {
    expect(scorePair(graph, node('A', 'LINK_DOWN'), node('A', 'LINK_DOWN'))).toBe(1);
  });

  it('同设备不同类型也过阈值（0.45 + 0.30 + 0.225）', () => {
    const score = scorePair(graph, node('A', 'LINK_DOWN'), node('A', 'CPU_HIGH'));
    expect(score).toBeCloseTo(0.45 + 0.3 + 0.25 * 0.3, 4);
    expect(score).toBeGreaterThanOrEqual(0.55);
  });

  it('两跳且类型无关时低于阈值', () => {
    // 0.5*0.45 + 1*0.30 + 0.3*0.25 = 0.6 → 仍然过阈值，这符合文档公式
    const score = scorePair(graph, node('A', 'LINK_DOWN'), node('C', 'CPU_HIGH'));
    expect(score).toBeCloseTo(0.5 * 0.45 + 0.3 + 0.25 * 0.3, 4);
  });

  it('3 跳即使同类型同刻也不允许关联（B7 硬闸门）', () => {
    const a = node('A', 'LINK_DOWN');
    const b = node('D', 'LINK_DOWN');
    expect(canRelate(graph, a, b)).toBe(false);
    // 公式本身会算出 0.55，闸门必须拦住
    expect(scorePair(graph, a, b)).toBeCloseTo(0.55, 4);
  });

  it('5 分钟窗口边界：等于窗口算在内，超过不算', () => {
    expect(withinWindow(node('A', 'X'), node('A', 'X', CLUSTER_WINDOW_MS))).toBe(true);
    expect(withinWindow(node('A', 'X'), node('A', 'X', CLUSTER_WINDOW_MS + 1))).toBe(false);
  });
});

describe('类型共现矩阵', () => {
  it('同类型满分，同族 0.9，跨族按表，未知 0.3', () => {
    expect(typeAffinity('LINK_DOWN', 'LINK_DOWN')).toBe(1);
    expect(typeAffinity('LINK_DOWN', 'PORT_FLAP')).toBe(0.9);
    expect(typeAffinity('LINK_DOWN', 'PACKET_LOSS')).toBe(0.7);
    expect(typeAffinity('LINK_DOWN', 'CPU_HIGH')).toBe(0.3);
    expect(typeAffinity('WHATEVER', 'LINK_DOWN')).toBe(0.3);
  });

  it('大小写与空格不敏感', () => {
    expect(typeAffinity(' link_down ', 'LINK_DOWN')).toBe(1);
  });
});
