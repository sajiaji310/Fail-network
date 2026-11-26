import { afterEach, describe, expect, it } from 'vitest';
import { env } from '@/lib/env';
import { makeContext } from './test-utils';
import { ruleFallback } from './fallback';
import { RESCUE_REASON, dedupeByCategoryAndDevice, rescueEmptyResult } from './rescue';
import type { HypothesisDraft } from './schema';

/**
 * 空结论补位单测（Spec §3.4）。
 *
 * 补位是"给空结论垫一条候选"，最容易踩的坑不是补错，而是**补过头**：
 * 该保持空的时候（规则也说不出来 / 本来就是规则给的）也去凑一条，就等于把 AC-20 废掉。
 * 所以这里一半用例在验"补得对"，另一半在验"不该补的时候一条都不补"。
 */

const ctx = makeContext();
const savedRescue = env.RCA_RESCUE;

afterEach(() => {
  env.RCA_RESCUE = savedRescue;
});

const base = {
  ctx,
  source: 'LLM' as const,
  degradedReason: null,
  summary: '模型给的摘要',
  impactScope: '模型给的影响面',
  missingInfo: [] as string[],
};

function hypothesis(over: Partial<HypothesisDraft> = {}): HypothesisDraft {
  return {
    cause: '模型的一条结论',
    category: 'LINK',
    confidence: 0.5,
    evidence: [{ type: 'ALERT', ref: 'alert-link-down', desc: '链路 Down' }],
    verifySteps: ['查看端口状态'],
    actions: [],
    ...over,
  };
}

describe('补位发生时的行为', () => {
  it('kept 为空 + source=LLM + RCA_RESCUE=on → 用规则引擎的候选补上', () => {
    env.RCA_RESCUE = 'on';
    const result = rescueEmptyResult({ ...base, kept: [], missingInfo: ['还缺变更数据'] });
    expect(result.rescued).toBe(true);
    expect(result.hypotheses.length).toBeGreaterThan(0);
    expect(result.hypotheses).toEqual(ruleFallback(ctx).hypotheses);
  });

  it('补位后 source 落 RULE_FALLBACK，degradedReason 用 Spec 原文', () => {
    env.RCA_RESCUE = 'on';
    const result = rescueEmptyResult({ ...base, kept: [], missingInfo: [] });
    expect(result.source).toBe('RULE_FALLBACK');
    expect(result.degradedReason).toBe(RESCUE_REASON);
  });

  it('summary / impactScope 跟着补位来源走（不能出现"规则结论配模型摘要"）', () => {
    env.RCA_RESCUE = 'on';
    const result = rescueEmptyResult({ ...base, kept: [], missingInfo: [] });
    expect(result.summary).toBe(ruleFallback(ctx).summary);
    expect(result.summary).not.toBe(base.summary);
    expect(result.impactScope).toBe(ruleFallback(ctx).impactScope);
  });

  it('origin 与 hypotheses 同序同长，全标 RULE_FALLBACK', () => {
    env.RCA_RESCUE = 'on';
    const result = rescueEmptyResult({ ...base, kept: [], missingInfo: [] });
    expect(result.origin).toHaveLength(result.hypotheses.length);
    expect(result.origin.every((o) => o === 'RULE_FALLBACK')).toBe(true);
  });

  it('missingInfo 与规则引擎的缺失项取并集，截断 5 条', () => {
    env.RCA_RESCUE = 'on';
    const many = Array.from({ length: 4 }, (_, i) => `缺项 ${i}`);
    const result = rescueEmptyResult({ ...base, kept: [], missingInfo: many });
    expect(result.missingInfo.length).toBeLessThanOrEqual(5);
    expect(result.missingInfo).toContain('缺项 0');
  });

  it('同类别同主设备的候选只留一条（去重键 category|主设备名）', () => {
    env.RCA_RESCUE = 'on';
    const first: HypothesisDraft = {
      ...hypothesis(),
      cause: 'AGG-SW-02 光模块劣化',
      category: 'LINK',
    };
    const duplicate: HypothesisDraft = { ...first, cause: '同一台设备同一类别的另一种说法' };
    const otherDevice: HypothesisDraft = {
      ...first,
      cause: '另一台设备的光模块劣化',
      evidence: [{ type: 'ALERT', ref: 'alert-far-loss', desc: 'ACC-SW-11 丢包' }],
    };
    const otherCategory: HypothesisDraft = { ...first, cause: '同一台设备的配置问题', category: 'CONFIG' };

    const deduped = dedupeByCategoryAndDevice(
      [first, duplicate, otherDevice, otherCategory],
      ctx,
    );
    // 键 = LINK|AGG-SW-02 / LINK|ACC-SW-11 / CONFIG|AGG-SW-02
    expect(deduped).toHaveLength(3);
    expect(deduped).toContain(first);
    expect(deduped).not.toContain(duplicate);
  });

  it('补位后的候选里不存在重复的 category|主设备名', () => {
    env.RCA_RESCUE = 'on';
    const result = rescueEmptyResult({ ...base, kept: [], missingInfo: [] });
    const keys = result.hypotheses.map((h) => {
      const alertRef = h.evidence.find((e) => e.type === 'ALERT')?.ref;
      const device = ctx.alerts.find((a) => a.id === alertRef)?.deviceName ?? '';
      return `${h.category}|${device}`;
    });
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('不该补位的时候一条都不补', () => {
  it('kept 非空时原样返回，不混入规则候选', () => {
    env.RCA_RESCUE = 'on';
    const kept = [hypothesis()];
    const result = rescueEmptyResult({ ...base, kept, missingInfo: [] });
    expect(result.rescued).toBe(false);
    expect(result.hypotheses).toEqual(kept);
    expect(result.source).toBe('LLM');
    expect(result.degradedReason).toBeNull();
  });

  it('source 已经是 RULE_FALLBACK 时不再补一次（规则自己给的空就是空）', () => {
    env.RCA_RESCUE = 'on';
    const result = rescueEmptyResult({
      ...base,
      kept: [],
      source: 'RULE_FALLBACK',
      degradedReason: '未配置 LLM_API_KEY，本次由规则引擎给出结论',
      missingInfo: [],
    });
    expect(result.rescued).toBe(false);
    expect(result.hypotheses).toHaveLength(0);
    expect(result.source).toBe('RULE_FALLBACK');
  });

  it('RCA_RESCUE=off 时保持空结论（回滚路径）', () => {
    env.RCA_RESCUE = 'off';
    const result = rescueEmptyResult({ ...base, kept: [], missingInfo: [] });
    expect(result.rescued).toBe(false);
    expect(result.hypotheses).toHaveLength(0);
  });

  it('规则引擎也返回空（R1 场景）→ 保持空，不为凑数编造', () => {
    env.RCA_RESCUE = 'on';
    // 单设备、无链路、无变更、类型未登记：dev-14 / test-07 的形态，规则引擎自己也给不出候选
    const single = ctx.alerts[0]!;
    const emptyCtx = {
      ...ctx,
      nodes: ctx.nodes.filter((n) => n.id === single.deviceId),
      links: [],
      changes: [],
      metrics: [],
      alerts: [0, 1, 2].map((i) => ({
        ...single,
        id: `u-${i}`,
        type: `UNKNOWN_SENSOR_${i}`,
        alertClass: 'UNKNOWN' as const,
      })),
    };
    expect(ruleFallback(emptyCtx).hypotheses).toHaveLength(0);
    const result = rescueEmptyResult({
      ...base,
      ctx: emptyCtx,
      kept: [],
      missingInfo: ['闸门 R1 命中的说明'],
    });
    expect(result.rescued).toBe(false);
    expect(result.hypotheses).toHaveLength(0);
    expect(result.missingInfo).toContain('闸门 R1 命中的说明');
  });
});
