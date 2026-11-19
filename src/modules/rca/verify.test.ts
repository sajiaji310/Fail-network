import { describe, expect, it } from 'vitest';
import type { HypothesisDraft } from './schema';
import { buildVerifyContext, isEvidenceRelevant, verifyHypotheses } from './verify';
import { makeContext } from './test-utils';

/**
 * 证据校验器单测（AC-06 / AC-18 / AC-20 + L3 降权）。
 * 夹具拓扑见 test-utils：ACC-SW-11 距影响面 3 跳，是"引用存在但无关"的标准样本。
 */

const ctx = buildVerifyContext(makeContext());

function draft(overrides: Partial<HypothesisDraft> = {}): HypothesisDraft {
  return {
    cause: 'AGG-SW-02 线卡故障导致整机不可达',
    category: 'HARDWARE',
    confidence: 0.8,
    evidence: [{ type: 'ALERT', ref: 'alert-linecard', desc: '线卡故障' }],
    verifySteps: ['检查线卡状态'],
    actions: [{ action: '更换线卡', risk: 'HIGH', requiresApproval: true }],
    ...overrides,
  };
}

describe('L1 存在性（AC-06）', () => {
  it('引用不存在的 alertId → 整条假设丢弃，原因 EVIDENCE_NOT_FOUND', () => {
    const result = verifyHypotheses(
      [draft({ evidence: [{ type: 'ALERT', ref: 'alert-ghost', desc: '编造的告警' }] })],
      ctx,
    );
    expect(result.kept).toHaveLength(0);
    expect(result.dropped[0]?.reason).toBe('EVIDENCE_NOT_FOUND');
    expect(result.dropped[0]?.detail).toContain('ALERT:alert-ghost');
  });

  it('一条假证据 + 一条真证据 → 仍整条丢弃（推理链断了，不能只删一环）', () => {
    const result = verifyHypotheses(
      [
        draft({
          evidence: [
            { type: 'ALERT', ref: 'alert-linecard', desc: '真实告警' },
            { type: 'CHANGE', ref: 'change-ghost', desc: '编造的变更' },
          ],
        }),
      ],
      ctx,
    );
    expect(result.kept).toHaveLength(0);
    expect(result.dropped[0]?.reason).toBe('EVIDENCE_NOT_FOUND');
  });

  it('四类证据都用错类型引用（链路 id 当告警用）也会被 L1 拦下', () => {
    const result = verifyHypotheses(
      [draft({ evidence: [{ type: 'ALERT', ref: 'link-core-agg2', desc: '张冠李戴' }] })],
      ctx,
    );
    expect(result.kept).toHaveLength(0);
    expect(result.dropped[0]?.reason).toBe('EVIDENCE_NOT_FOUND');
  });
});

describe('L2 相关性（AC-18）', () => {
  it('告警设备距影响面 3 跳 → 证据剔除；只剩它则整条丢弃 EVIDENCE_IRRELEVANT', () => {
    const result = verifyHypotheses(
      [
        draft({
          cause: 'ACC-SW-11 丢包引发汇聚不可达',
          evidence: [{ type: 'ALERT', ref: 'alert-far-loss', desc: '远端丢包' }],
        }),
      ],
      ctx,
    );
    expect(result.kept).toHaveLength(0);
    expect(result.dropped[0]?.reason).toBe('EVIDENCE_IRRELEVANT');
  });

  it('无关证据被剔除后，剩余证据仍能支撑假设 → 保留并降权', () => {
    const result = verifyHypotheses(
      [
        draft({
          evidence: [
            { type: 'ALERT', ref: 'alert-linecard', desc: '线卡故障' },
            { type: 'ALERT', ref: 'alert-far-loss', desc: '远端丢包（无关）' },
          ],
        }),
      ],
      ctx,
    );
    expect(result.kept).toHaveLength(1);
    expect(result.kept[0]?.evidence).toHaveLength(1);
    // 0.8 * (0.6 + 0.4 * 0.5) = 0.64
    expect(result.kept[0]?.confidence).toBeCloseTo(0.64, 3);
    expect(result.stats).toMatchObject({ rawEvidence: 2, validEvidence: 1, relevanceRate: 0.5 });
  });

  it('晚于首个告警的变更不能当原因', () => {
    expect(isEvidenceRelevant(ctx, 'CHANGE', 'change-late')).toBe(false);
    expect(isEvidenceRelevant(ctx, 'CHANGE', 'change-core')).toBe(true);
  });

  it('变更设备在 3 跳外同样不相关', () => {
    expect(isEvidenceRelevant(ctx, 'CHANGE', 'change-far')).toBe(false);
  });

  it('链路两端都不在影响面 → 不相关；有一端在内 → 相关', () => {
    expect(isEvidenceRelevant(ctx, 'TOPOLOGY', 'link-agg3-acc11')).toBe(false);
    expect(isEvidenceRelevant(ctx, 'TOPOLOGY', 'link-core-agg2')).toBe(true);
  });

  it('案例 tags 与告警类型无交集 → 不相关', () => {
    expect(isEvidenceRelevant(ctx, 'CASE', 'case-power')).toBe(true);
    expect(isEvidenceRelevant(ctx, 'CASE', 'case-cloud')).toBe(false);
  });

  it('证据全在 3 跳外 → AC-20 空结论', () => {
    const result = verifyHypotheses(
      [
        draft({
          evidence: [
            { type: 'ALERT', ref: 'alert-far-loss', desc: '远端' },
            { type: 'CHANGE', ref: 'change-far', desc: '远端变更' },
            { type: 'CASE', ref: 'case-cloud', desc: '无关案例' },
          ],
        }),
      ],
      ctx,
    );
    expect(result.kept).toHaveLength(0);
    expect(result.dropped).toHaveLength(1);
    expect(result.stats.validEvidence).toBe(0);
    expect(result.stats.relevanceRate).toBe(0);
  });
});

describe('L3 一致性（只降权不丢弃）', () => {
  it('证据有效率 1/2 → 置信度乘 0.8', () => {
    const result = verifyHypotheses(
      [
        draft({
          evidence: [
            { type: 'ALERT', ref: 'alert-linecard', desc: '相关' },
            { type: 'ALERT', ref: 'alert-far-loss', desc: '无关' },
          ],
        }),
      ],
      ctx,
    );
    expect(result.kept[0]?.confidence).toBeCloseTo(0.64, 3);
  });

  it('变更与首个告警间隔 < 60s → 再乘 0.9（太巧合，可能是结果而非原因）', () => {
    const tight = makeContext();
    const first = tight.changes[0];
    if (!first) throw new Error('夹具缺少变更');
    // 首个告警在 T0，此处把变更挪到前 30 秒
    tight.changes[0] = { ...first, changedAt: new Date('2026-11-19T01:59:30Z').toISOString() };
    const tightCtx = buildVerifyContext(tight);

    const result = verifyHypotheses(
      [
        draft({
          evidence: [{ type: 'CHANGE', ref: 'change-core', desc: '30 秒前的变更' }],
        }),
      ],
      tightCtx,
    );
    expect(result.kept).toHaveLength(1);
    // 0.8 * 1.0 * 0.9 = 0.72
    expect(result.kept[0]?.confidence).toBeCloseTo(0.72, 3);
  });

  it('全部证据有效时不降权', () => {
    const result = verifyHypotheses([draft({ confidence: 0.9 })], ctx);
    expect(result.kept[0]?.confidence).toBeCloseTo(0.9, 3);
  });

  it('按调整后的置信度重排（证据被削的假设会掉到后面）', () => {
    const result = verifyHypotheses(
      [
        draft({
          cause: '证据被削弱的假设',
          confidence: 0.8,
          evidence: [
            { type: 'ALERT', ref: 'alert-linecard', desc: '相关' },
            { type: 'ALERT', ref: 'alert-far-loss', desc: '无关' },
          ],
        }),
        draft({ cause: '证据完整的假设', confidence: 0.7 }),
      ],
      ctx,
    );
    expect(result.kept[0]?.cause).toBe('证据完整的假设');
  });
});
