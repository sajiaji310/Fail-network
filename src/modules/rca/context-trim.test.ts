import { describe, expect, it } from 'vitest';
import { CONTEXT_CHAR_BUDGET, MAX_ALERTS_TRIMMED, measureBundle, trimBundle } from './context-trim';
import { makeContext } from './test-utils';

/**
 * 上下文裁剪单测（文档 10.1）：顺序必须是 指标 → 历史 → 拓扑(1 跳) → 告警(Top10)，
 * 而且裁到没得裁就要停手，不能为了凑预算把证据削成空数组。
 */

function fatContext() {
  const base = makeContext();
  const alerts = Array.from({ length: 40 }, (_, index) => {
    const source = base.alerts[index % base.alerts.length];
    if (!source) throw new Error('夹具缺少告警');
    return {
      ...source,
      id: `alert-fat-${index}`,
      message: `${source.message} ${'填充'.repeat(40)}`,
    };
  });
  return { ...base, alerts };
}

describe('measureBundle', () => {
  it('体积随告警条数增长', () => {
    const thin = makeContext();
    const fat = fatContext();
    expect(measureBundle(fat)).toBeGreaterThan(measureBundle(thin));
  });
});

describe('trimBundle 裁剪顺序', () => {
  it('预算充足时不动任何证据', () => {
    const bundle = makeContext();
    const trimmed = trimBundle(bundle, 1_000_000);
    expect(trimmed.trim.trimmed).toHaveLength(0);
    expect(trimmed.alerts).toHaveLength(bundle.alerts.length);
    expect(trimmed.cases).toHaveLength(bundle.cases.length);
  });

  it('超预算时先砍指标，再砍历史案例', () => {
    const trimmed = trimBundle(fatContext(), 6_000);
    expect(trimmed.trim.trimmed[0]).toBe('metrics');
    expect(trimmed.metrics).toHaveLength(0);
    expect(trimmed.trim.trimmed).toContain('cases');
  });

  it('告警最多保留 10 条，且优先保留高严重度', () => {
    const trimmed = trimBundle(fatContext(), 1_200);
    expect(trimmed.alerts.length).toBeLessThanOrEqual(MAX_ALERTS_TRIMMED);
    expect(trimmed.alerts[0]?.severity).toBe('P0');
  });

  it('拓扑先降到 1 跳，再考虑动告警', () => {
    const trimmed = trimBundle(fatContext(), 3_000);
    expect(trimmed.trim.trimmed).toContain('topology');
    expect(trimmed.links.every((l) => l.hopsToIncident <= 1)).toBe(true);
  });

  it('四步裁完仍超预算就停手（不把证据削光）', () => {
    const trimmed = trimBundle(fatContext(), 10);
    expect(trimmed.trim.trimmed).toHaveLength(4);
    expect(trimmed.alerts.length).toBe(MAX_ALERTS_TRIMMED);
    expect(trimmed.nodes).toHaveLength(2); // 设备清单不属于可裁项
  });

  it('默认预算常量与文档 6k tokens 对齐', () => {
    expect(CONTEXT_CHAR_BUDGET).toBe(13_000);
  });
});
