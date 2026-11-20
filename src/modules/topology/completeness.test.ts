import { describe, expect, it } from 'vitest';
import { assessTopology, capConfidence, coverageNote, CONFIDENCE_CAP } from './completeness';

const dev = (id: string, name = id) => ({ id, name });
const link = (sourceId: string, targetId: string) => ({ sourceId, targetId });

describe('assessTopology', () => {
  it('事件设备全部有链路且连通 → FULL', () => {
    const result = assessTopology(
      [dev('core'), dev('agg')],
      [link('core', 'agg'), link('agg', 'acc')],
    );
    expect(result.level).toBe('FULL');
    expect(result.linkedDevices).toBe(2);
    expect(result.components).toBe(1);
    expect(result.ratio).toBe(1);
    expect(result.linkCount).toBe(2);
    expect(coverageNote(result)).toBeNull();
  });

  it('有一台设备没有任何链路 → PARTIAL 并点名缺哪台', () => {
    const result = assessTopology([dev('core'), dev('agg', 'AGG-SW-02')], [link('core', 'edge')]);
    expect(result.level).toBe('PARTIAL');
    expect(result.isolatedDevices).toEqual([{ id: 'agg', name: 'AGG-SW-02' }]);
    expect(coverageNote(result)).toContain('AGG-SW-02');
  });

  it('一条链路都没有 → MISSING', () => {
    const result = assessTopology([dev('core'), dev('agg')], []);
    expect(result.level).toBe('MISSING');
    expect(result.linkedDevices).toBe(0);
    expect(result.ratio).toBe(0);
    expect(coverageNote(result)).toContain('拓扑');
  });

  it('设备分成两个互不相连的部分 → PARTIAL（扩散路径缺链）', () => {
    const result = assessTopology(
      [dev('agg-a'), dev('agg-b')],
      [link('agg-a', 'core-1'), link('agg-b', 'core-2')],
    );
    expect(result.level).toBe('PARTIAL');
    expect(result.linkedDevices).toBe(2);
    expect(result.components).toBe(2);
    expect(coverageNote(result)).toContain('2 个互不相连');
  });

  it('经由非事件设备连通也算同一分量（核心 → 汇聚常经中间设备）', () => {
    const result = assessTopology(
      [dev('agg-a'), dev('agg-b')],
      [link('agg-a', 'core'), link('core', 'agg-b')],
    );
    expect(result.level).toBe('FULL');
    expect(result.components).toBe(1);
    expect(result.maxHops).toBe(2);
  });

  it('事件设备之间相隔超过 2 跳 → PARTIAL（中间的链路可能没采到）', () => {
    const result = assessTopology(
      [dev('core'), dev('acc')],
      [link('core', 'agg1'), link('agg1', 'agg2'), link('agg2', 'acc')],
    );
    expect(result.level).toBe('PARTIAL');
    expect(result.components).toBe(1);
    expect(result.maxHops).toBe(3);
    expect(coverageNote(result)).toContain('超过 2 跳');
  });

  it('空事件不算 FULL', () => {
    expect(assessTopology([], []).level).toBe('MISSING');
  });
});

describe('capConfidence', () => {
  it('按完整度截断，且不抬高原有置信度', () => {
    expect(capConfidence(0.9, 'FULL')).toBe(0.9);
    expect(capConfidence(0.9, 'PARTIAL')).toBe(CONFIDENCE_CAP.PARTIAL);
    expect(capConfidence(0.9, 'MISSING')).toBe(CONFIDENCE_CAP.MISSING);
    expect(capConfidence(0.3, 'MISSING')).toBe(0.3);
  });
});
