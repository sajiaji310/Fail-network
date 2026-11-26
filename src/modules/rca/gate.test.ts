import { describe, expect, it } from 'vitest';
import {
  ABSTAIN_MISSING_INFO,
  clearanceMissingInfo,
  gateHypotheses,
  R1_REASON,
  shouldAbstainBeforeModel,
} from './gate';
import { isExplainedType } from './explainability';
import { makeContext } from './test-utils';
import type { ContextAlert, ContextBundle, ContextChange } from './context';
import type { HypothesisDraft } from './schema';

/**
 * 两段式门禁单测（Spec §3.3 / 验收标准 1、2、3、5）。
 *
 * 用例挑的是"最容易出错的两头"：既要有该拒答的场景别漏放，也要有该出结论的场景别误杀。
 * 后者更重要 —— 门禁误杀的代价是值班人连候选都看不到，比给一条弱结论更糟。
 */

const ctx = makeContext();

/** 把上下文改造成"全部告警类型未登记"的形态（test-07/16 的骨架） */
function allUnknown(base: ContextBundle, changes: ContextChange[] = []): ContextBundle {
  const alerts: ContextAlert[] = base.alerts.map((alert, index) => ({
    ...alert,
    id: `unknown-${index}`,
    type: `UNKNOWN_SENSOR_${index}`,
    alertClass: 'UNKNOWN',
  }));
  return { ...base, alerts, changes };
}

function hypothesis(over: Partial<HypothesisDraft> = {}): HypothesisDraft {
  return {
    cause: 'AGG-SW-02 线卡故障导致下游告警',
    category: 'HARDWARE',
    confidence: 0.6,
    evidence: [{ type: 'ALERT', ref: 'alert-linecard', desc: '线卡故障' }],
    verifySteps: ['登录设备查看硬件状态'],
    actions: [],
    ...over,
  };
}

describe('前置 R1：该拒答时拒答', () => {
  it('全部告警未登记 + 只有晚于首告警的变更 → 命中（test-07 / test-16 形态）', () => {
    const late = ctx.changes.filter((c) => !c.beforeFirstAlert);
    const decision = shouldAbstainBeforeModel(allUnknown(ctx, late));
    expect(decision.abstain).toBe(true);
    expect(decision.reason).toBe(R1_REASON);
  });

  it('全部告警未登记 + 完全没有变更 → 命中', () => {
    expect(shouldAbstainBeforeModel(allUnknown(ctx)).abstain).toBe(true);
  });

  it('事件里一条告警都没有时不由 R1 管（不拒答，交给其它路径）', () => {
    const decision = shouldAbstainBeforeModel({ ...ctx, alerts: [], changes: [] });
    expect(decision.abstain).toBe(false);
    expect(decision.reason).toBeNull();
  });
});

describe('前置 R1：不该拒答时放行', () => {
  it('部分类型未登记、但存在已登记告警 → 不命中（test-10 形态）', () => {
    const mixed: ContextBundle = {
      ...allUnknown(ctx),
      alerts: [
        { ...ctx.alerts[0]!, id: 'unknown-0', type: 'UNKNOWN_SENSOR_A', alertClass: 'UNKNOWN' },
        { ...ctx.alerts[0]!, id: 'known-1' },
      ],
    };
    expect(shouldAbstainBeforeModel(mixed).abstain).toBe(false);
  });

  it('全部告警未登记 + 有一条事件前变更 → 不命中（变更本身可归因）', () => {
    const before = ctx.changes.filter((c) => c.beforeFirstAlert);
    expect(shouldAbstainBeforeModel(allUnknown(ctx, before)).abstain).toBe(false);
  });

  it('已抑制的已登记告警不参与 R1 判定（只看值班人实际看到的那批）', () => {
    // 场景：唯一一条已登记告警是被抑制的（父告警连带压掉的端口告警），其余都是未登记类型。
    // 按"含已抑制项"的口径会放行，按"只算未抑制"的口径必须拒答。
    const suppressedKnown: ContextBundle = {
      ...allUnknown(ctx, []),
      alerts: [
        ...allUnknown(ctx, []).alerts,
        { ...ctx.alerts[0]!, id: 'suppressed-known', suppressed: true },
      ],
    };
    expect(suppressedKnown.alerts.some((a) => a.suppressed && isExplainedType(a.type))).toBe(true);
    expect(shouldAbstainBeforeModel(suppressedKnown).abstain).toBe(true);
  });

  it('只剩已抑制告警时不由 R1 管（没有未抑制告警 = 没有可判定的现场）', () => {
    const allSuppressed: ContextBundle = {
      ...ctx,
      alerts: ctx.alerts.map((a) => ({ ...a, suppressed: true })),
      changes: [],
    };
    expect(shouldAbstainBeforeModel(allSuppressed).abstain).toBe(false);
  });
});

describe('拒答文案（PRD §2.3 三段式 + 禁用词）', () => {
  it('带 TYPE_UNKNOWN 前缀、三段式、且给出可执行采集动作', () => {
    expect(ABSTAIN_MISSING_INFO.startsWith('[TYPE_UNKNOWN]')).toBe(true);
    expect(ABSTAIN_MISSING_INFO.split('→')).toHaveLength(3); // 缺什么 → 为什么不能定论 → 怎么补
    expect(ABSTAIN_MISSING_INFO).toContain('采集项映射');
  });

  it('不含黑名单套话（否则等于没说）', () => {
    for (const banned of ['请提供更多信息', '建议进一步排查', '疑似', '可能存在问题']) {
      expect(ABSTAIN_MISSING_INFO).not.toContain(banned);
    }
  });
});

describe('GATE-02：只认 ALERT / CHANGE', () => {
  it('证据仅由 TOPOLOGY 构成 → 整条清空并给出原因', () => {
    const result = gateHypotheses({
      hypotheses: [
        hypothesis({
          evidence: [{ type: 'TOPOLOGY', ref: 'link-core-agg2', desc: '核心到汇聚链路 Up' }],
        }),
      ],
      ctx,
    });
    expect(result.kept).toHaveLength(0);
    expect(result.cleared).toHaveLength(1);
    expect(result.cleared[0]?.reason).toContain('GATE-02');
    expect(result.cleared[0]?.detail).toContain('TOPOLOGY');
  });

  it('证据由 METRIC + CASE 构成 → 清空（这两类证明的是"有关联"，不是"是原因"）', () => {
    const result = gateHypotheses({
      hypotheses: [
        hypothesis({
          evidence: [
            { type: 'METRIC', ref: 'metric:ACC-SW-11:packet_loss', desc: '丢包 3.2%' },
            { type: 'CASE', ref: 'case-power', desc: '历史案例：电源故障' },
          ],
        }),
      ],
      ctx,
    });
    expect(result.kept).toHaveLength(0);
    expect(result.cleared).toHaveLength(1);
  });

  it('证据含已登记 ALERT → 保留', () => {
    const result = gateHypotheses({ hypotheses: [hypothesis()], ctx });
    expect(result.kept).toHaveLength(1);
    expect(result.cleared).toHaveLength(0);
  });

  it('证据含事件前 CHANGE → 保留（即使没有任何告警证据）', () => {
    const result = gateHypotheses({
      hypotheses: [
        hypothesis({
          category: 'CONFIG',
          evidence: [{ type: 'CHANGE', ref: 'change-core', desc: 'ACL 策略下发' }],
        }),
      ],
      ctx,
    });
    expect(result.kept).toHaveLength(1);
  });

  it('证据含晚于首告警的 CHANGE → 清空（不是"是原因"的证据）', () => {
    const result = gateHypotheses({
      hypotheses: [
        hypothesis({
          evidence: [{ type: 'CHANGE', ref: 'change-late', desc: '事件开始后补录的变更' }],
        }),
      ],
      ctx,
    });
    expect(result.kept).toHaveLength(0);
  });

  it('证据里的 ALERT 类型未登记 → 不算可归因，清空', () => {
    const unknownAlert = { ...ctx.alerts[0]!, id: 'unknown-x', type: 'UNKNOWN_SENSOR_A' };
    const result = gateHypotheses({
      hypotheses: [hypothesis({ evidence: [{ type: 'ALERT', ref: 'unknown-x', desc: '未登记' }] })],
      ctx: { ...ctx, alerts: [...ctx.alerts, unknownAlert] },
    });
    expect(result.kept).toHaveLength(0);
  });

  it('多条假设逐条判定：能归因的留下，只有拓扑的清澈', () => {
    const result = gateHypotheses({
      hypotheses: [
        hypothesis({ cause: '有告警证据的一条' }),
        hypothesis({
          cause: '只有链路证据的一条',
          evidence: [{ type: 'TOPOLOGY', ref: 'link-agg2-acc7', desc: '链路 Down' }],
        }),
      ],
      ctx,
    });
    expect(result.kept.map((h) => h.cause)).toEqual(['有告警证据的一条']);
    expect(result.cleared.map((h) => h.cause)).toEqual(['只有链路证据的一条']);
  });

  it('清空原因进 missingInfo 时是给人看的一句话', () => {
    const result = gateHypotheses({
      hypotheses: [
        hypothesis({
          cause: 'ACC-SW-07 光模块劣化',
          evidence: [{ type: 'TOPOLOGY', ref: 'link-agg2-acc7', desc: '链路 Down' }],
        }),
      ],
      ctx,
    });
    const lines = clearanceMissingInfo(result.cleared);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('GATE-02');
    expect(lines[0]).toContain('ACC-SW-07 光模块劣化');
  });
});
