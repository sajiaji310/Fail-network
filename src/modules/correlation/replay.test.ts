import { describe, expect, test } from 'vitest';
import { FOLLOWUP_LOOKBACK_MS } from './constants';
import { MAX_REPLAY_SPAN_MS, replayCursors } from './replay';

const T0 = new Date('2026-11-10T00:00:00Z');
const plus = (ms: number) => new Date(T0.getTime() + ms);

describe('replayCursors', () => {
  test('起止相同只跑一个时刻', () => {
    expect(replayCursors({ from: T0, to: T0 }).map((d) => d.toISOString())).toEqual([
      T0.toISOString(),
    ]);
  });

  test('按 2 小时步进，最后一跳停在结束时刻', () => {
    const to = plus(3 * 60 * 60 * 1000);
    const cursors = replayCursors({ from: T0, to });
    expect(cursors.map((d) => d.toISOString())).toEqual([
      T0.toISOString(),
      plus(FOLLOWUP_LOOKBACK_MS).toISOString(),
      to.toISOString(),
    ]);
  });

  test('步长超过回看窗会在两步之间漏告警', () => {
    expect(() =>
      replayCursors({ from: T0, to: plus(6 * 60 * 60 * 1000), stepMs: FOLLOWUP_LOOKBACK_MS + 1 }),
    ).toThrow(/2 小时/);
  });

  test('结束早于开始、跨度超过 7 天都拒绝', () => {
    expect(() => replayCursors({ from: plus(1000), to: T0 })).toThrow(/结束时间/);
    expect(() => replayCursors({ from: T0, to: plus(MAX_REPLAY_SPAN_MS + 1) })).toThrow(/7 天/);
  });
});
