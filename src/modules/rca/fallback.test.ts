import { describe, expect, it } from 'vitest';
import { ruleFallback } from './fallback';
import { buildVerifyContext, verifyHypotheses } from './verify';
import { makeContext } from './test-utils';

/**
 * 规则 fallback 单测（AC-07）。除了打分排序，最关键的一条是"自洽性"：
 * fallback 自己产出的假设，必须能通过同一套证据校验器 —— 否则无 key 环境下
 * 用户会看到"规则引擎给的结论被自己的校验器全丢掉"这种荒唐结果。
 */

const ctx = makeContext();

describe('规则打分（+40 变更 / +30 直连 / +20 类型 / +10 历史）', () => {
  it('有事件前变更时，变更设备排第一且归类 CONFIG（+40 是最高权重）', () => {
    const result = ruleFallback(ctx);
    const top = result.hypotheses[0];
    expect(top?.evidence.some((e) => e.type === 'CHANGE' && e.ref === 'change-core')).toBe(true);
    expect(top?.category).toBe('CONFIG');
    expect(top?.cause).toContain('变更');
  });

  it('去掉变更后，ROOT 级硬件告警的设备升到第一', () => {
    const noChange = { ...ctx, changes: [] };
    const result = ruleFallback(noChange);
    const top = result.hypotheses[0];
    expect(top?.evidence.some((e) => e.ref === 'alert-linecard')).toBe(true);
    expect(top?.category).toBe('HARDWARE');
  });

  it('置信度不超过 0.95，且不低于 0.15', () => {
    const result = ruleFallback(ctx);
    for (const hypothesis of result.hypotheses) {
      expect(hypothesis.confidence).toBeLessThanOrEqual(0.95);
      expect(hypothesis.confidence).toBeGreaterThanOrEqual(0.15);
    }
  });

  it('最多 3 条假设，每条至少 1 条证据', () => {
    const result = ruleFallback(ctx);
    expect(result.hypotheses.length).toBeLessThanOrEqual(3);
    for (const hypothesis of result.hypotheses) {
      expect(hypothesis.evidence.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('summary 与 impactScope 不超过契约上限', () => {
    const result = ruleFallback(ctx);
    expect(result.summary.length).toBeLessThanOrEqual(200);
    expect(result.impactScope.length).toBeLessThanOrEqual(200);
  });

  it('完全没有候选证据时返回空假设 + missingInfo，而不是编一个（AC-20 同源）', () => {
    const empty = { ...ctx, alerts: [], changes: [], nodes: [], links: [] };
    const result = ruleFallback(empty);
    expect(result.hypotheses).toHaveLength(0);
    expect(result.missingInfo.length).toBeGreaterThan(0);
  });
});

describe('fallback 与校验器自洽', () => {
  it('规则输出的每条证据都存在于上下文，校验后不丢任何一条', () => {
    const result = ruleFallback(ctx);
    const verified = verifyHypotheses(result.hypotheses, buildVerifyContext(ctx));
    expect(verified.dropped).toHaveLength(0);
    expect(verified.kept).toHaveLength(result.hypotheses.length);
    expect(verified.stats.relevanceRate).toBe(1);
  });
});

/**
 * T09 评测驱动的两处修正（dev 集里 5 个正例/干扰例因此从"空结论"变成命中）。
 * 这两条容易在后续调参里被无意改回去，所以锁在单测里。
 */
describe('弱信号场景的召回（T09 修正）', () => {
  const base = ctx.alerts[0]!;

  it('DNS_TIMEOUT 归类 UPSTREAM，不跟随 QUALITY 族判成 LINK', () => {
    const dnsCtx = {
      ...ctx,
      changes: [],
      cases: [],
      alerts: [{ ...base, id: 'alert-dns', type: 'DNS_TIMEOUT', alertClass: 'CHILD' as const }],
    };
    const result = ruleFallback(dnsCtx);
    expect(result.hypotheses[0]?.category).toBe('UPSTREAM');
  });

  it('只有「直连受影响设备」这一条信号时也要给结论', () => {
    const weakCtx = {
      ...ctx,
      changes: [],
      cases: [],
      alerts: [{ ...base, alertClass: 'CHILD' as const }],
    };
    expect(ruleFallback(weakCtx).hypotheses.length).toBeGreaterThan(0);
  });

  it('孤立单设备 + 未登记类型 → 仍给空结论（AC-20）', () => {
    const isolated = {
      ...ctx,
      changes: [],
      cases: [],
      links: [],
      nodes: ctx.nodes.filter((node) => node.id === base.deviceId),
      alerts: [
        {
          ...base,
          id: 'alert-unknown',
          type: 'UNKNOWN_SENSOR_A',
          alertClass: 'UNKNOWN' as const,
        },
      ],
    };
    expect(ruleFallback(isolated).hypotheses).toHaveLength(0);
  });

  it('孤立单设备但类型已知 → 给出结论（事件内唯一设备就是嫌疑）', () => {
    const isolated = {
      ...ctx,
      changes: [],
      cases: [],
      links: [],
      nodes: ctx.nodes.filter((node) => node.id === base.deviceId),
      alerts: [{ ...base, alertClass: 'CHILD' as const }],
    };
    const result = ruleFallback(isolated);
    expect(result.hypotheses).toHaveLength(1);
    expect(result.hypotheses[0]?.evidence[0]?.ref).toBe(base.id);
  });
});
