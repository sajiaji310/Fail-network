import { describe, expect, it } from 'vitest';
import { defaultWindow, percentile } from './metrics';

describe('运行指标口径', () => {
  it('分位数按向上取整定位，空集返回 null', () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([42], 90)).toBe(42);
    expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3);
    // 10 个值里 p90 落在第 9 个（索引 8），不是最大值
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9);
  });

  it('分位数不受长尾影响，均值会被拉偏', () => {
    const values = [600, 700, 800, 900, 100_000];
    const avg = values.reduce((s, v) => s + v, 0) / values.length;
    expect(percentile(values, 50)).toBe(800);
    expect(avg).toBeGreaterThan(20_000);
  });

  it('默认窗口是最近 N 天，to 为当前时刻', () => {
    const window = defaultWindow(7, new Date('2026-11-20T00:00:00Z'));
    expect(window.days).toBe(7);
    expect(window.to.toISOString()).toBe('2026-11-20T00:00:00.000Z');
    expect(window.from.toISOString()).toBe('2026-11-13T00:00:00.000Z');
  });
});
