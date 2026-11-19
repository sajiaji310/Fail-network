import { describe, expect, it } from 'vitest';
import { aggregate, scoreCase, answersOf, type Observation } from './metrics';
import type { EvalCase } from './schema';

/**
 * 打分器单测。这些断言的作用是"锁住尺子"：
 * 改评测脚本时，不能顺手把判定放宽 —— 否则分数变好看了，系统并没有变好。
 */

function makeCase(
  over: Partial<EvalCase> = {},
  expectOver: Partial<EvalCase['expect']> = {},
): EvalCase {
  return {
    id: 'dev-01',
    set: 'dev',
    kind: 'POSITIVE',
    title: '测试场景',
    note: '单测构造',
    mutations: { removeLinks: [] },
    scenario: {
      name: 'unit',
      title: '单测',
      description: '单测构造的场景',
      rootCauseHint: '核心线卡故障',
      changes: [],
      alerts: [
        {
          deviceName: 'CORE-SW-01',
          type: 'LINECARD_FAILURE',
          severity: 'P0',
          message: '线卡故障',
          minuteFromStart: 0,
        },
      ],
    },
    expect: {
      incidents: 1,
      rootCause: { category: 'HARDWARE', device: 'CORE-SW-01' },
      alternatives: [],
      ...expectOver,
    },
    ...over,
  };
}

const obs = (over: Partial<Observation> = {}): Observation => ({
  alertTotal: 10,
  incidentDevices: [['CORE-SW-01', 'AGG-SW-03']],
  rootAlertSuppressed: false,
  analyses: [
    {
      code: 'INC-1',
      source: 'RULE_FALLBACK',
      hypotheses: [
        {
          category: 'HARDWARE',
          cause: 'CORE-SW-01 发生线卡故障，下游连带',
          confidence: 0.78,
          deviceRefs: ['CORE-SW-01'],
        },
      ],
      dropped: 0,
      rawEvidence: 3,
      validEvidence: 3,
      durationMs: 20,
    },
  ],
  ...over,
});

describe('Top1/Top3 判定', () => {
  it('类别与设备都对 → Top1 命中', () => {
    const score = scoreCase(makeCase(), obs());
    expect(score.top1).toBe(true);
    expect(score.top3).toBe(true);
    expect(score.failures).toEqual([]);
  });

  it('类别对但设备不对 → 不算命中（防"只说对了是硬件故障"就拿分）', () => {
    const score = scoreCase(
      makeCase(),
      obs({
        analyses: [
          {
            code: 'INC-1',
            source: 'RULE_FALLBACK',
            hypotheses: [
              {
                category: 'HARDWARE',
                cause: 'AGG-SW-03 电源故障',
                confidence: 0.7,
                deviceRefs: ['AGG-SW-03'],
              },
            ],
            dropped: 0,
            rawEvidence: 1,
            validEvidence: 1,
            durationMs: 10,
          },
        ],
      }),
    );
    expect(score.top1).toBe(false);
    expect(score.top3).toBe(false);
  });

  it('证据指向标注设备但结论文本没点名 → 仍算命中', () => {
    const score = scoreCase(
      makeCase(),
      obs({
        analyses: [
          {
            code: 'INC-1',
            source: 'LLM',
            hypotheses: [
              {
                category: 'HARDWARE',
                cause: '主控转发芯片异常',
                confidence: 0.7,
                deviceRefs: ['CORE-SW-01'],
              },
            ],
            dropped: 0,
            rawEvidence: 2,
            validEvidence: 2,
            durationMs: 900,
          },
        ],
      }),
    );
    expect(score.top1).toBe(true);
  });

  it('等价答案任一命中即算对', () => {
    const kase = makeCase({}, { alternatives: [{ category: 'LINK', device: 'ACC-SW-19' }] });
    const score = scoreCase(
      kase,
      obs({
        analyses: [
          {
            code: 'INC-1',
            source: 'RULE_FALLBACK',
            hypotheses: [
              {
                category: 'LINK',
                cause: 'ACC-SW-19 光模块劣化',
                confidence: 0.6,
                deviceRefs: ['ACC-SW-19'],
              },
            ],
            dropped: 0,
            rawEvidence: 1,
            validEvidence: 1,
            durationMs: 10,
          },
        ],
      }),
    );
    expect(score.top1).toBe(true);
  });
});

describe('空结论（AC-20）', () => {
  const emptyCase = makeCase({}, { rootCause: null, incidents: 1 });

  it('期望空且确实为空 → 通过，且不计入 Top1 分母', () => {
    const score = scoreCase(
      emptyCase,
      obs({
        analyses: [
          {
            code: 'INC-1',
            source: 'RULE_FALLBACK',
            hypotheses: [],
            dropped: 0,
            rawEvidence: 0,
            validEvidence: 0,
            durationMs: 5,
          },
        ],
      }),
    );
    expect(score.emptyCorrect).toBe(true);
    expect(score.expectAnswer).toBe(false);
    expect(score.failures).toEqual([]);
  });

  it('期望空却给了假设 → 判失败（不许硬编根因）', () => {
    const score = scoreCase(emptyCase, obs());
    expect(score.emptyCorrect).toBe(false);
    expect(score.failures.join('；')).toContain('期望空结论');
  });

  it('期望有结论却为空 → 判失败（AC-20 反向）', () => {
    const score = scoreCase(
      makeCase(),
      obs({
        analyses: [
          {
            code: 'INC-1',
            source: 'RULE_FALLBACK',
            hypotheses: [],
            dropped: 0,
            rawEvidence: 0,
            validEvidence: 0,
            durationMs: 5,
          },
        ],
      }),
    );
    expect(score.emptyButExpectedAnswer).toBe(true);
    expect(score.failures.join('；')).toContain('期望有结论');
  });
});

describe('聚合层与误抑制', () => {
  it('事件数多于期望 → precision 下降、recall 满分', () => {
    const score = scoreCase(
      makeCase({}, { incidents: 1 }),
      obs({ incidentDevices: [['CORE-SW-01'], ['AGG-SW-03'], ['ACC-SW-02']] }),
    );
    expect(score.incidentTotal).toBe(3);
    expect(score.precision).toBeCloseTo(1 / 3, 3);
    expect(score.recall).toBe(1);
    expect(score.failures.join('；')).toContain('事件数 3');
  });

  it('期望 0 事件却生成了 1 个 → 精确率与召回率都不及格', () => {
    const score = scoreCase(
      makeCase({}, { incidents: 0, rootCause: null }),
      obs({ incidentDevices: [['ACC-SW-24']] }),
    );
    expect(score.precision).toBe(0);
    expect(score.recall).toBe(0);
  });

  it('标注根因告警被抑制 → 记入失败（AC-19 误抑制率必须为 0）', () => {
    const score = scoreCase(makeCase(), obs({ rootAlertSuppressed: true }));
    expect(score.failures.join('；')).toContain('误抑制');
  });

  it('标注设备不在任何事件里 → 聚合层失败', () => {
    const score = scoreCase(makeCase(), obs({ incidentDevices: [['AGG-SW-03']] }));
    expect(score.deviceCovered).toBe(false);
    expect(score.failures.join('；')).toContain('未覆盖标注设备');
  });
});

describe('汇总', () => {
  it('压缩比、证据率、分层命中按样本实数计算', () => {
    const kase = makeCase();
    const a = scoreCase(kase, obs());
    const b = scoreCase(
      makeCase({ id: 'dev-02', kind: 'DISTRACTOR' }),
      obs({
        alertTotal: 6,
        incidentDevices: [['CORE-SW-01']],
        analyses: [
          {
            code: 'INC-2',
            source: 'RULE_FALLBACK',
            hypotheses: [
              {
                category: 'HARDWARE',
                cause: 'CORE-SW-01 线卡故障',
                confidence: 0.7,
                deviceRefs: ['CORE-SW-01'],
              },
            ],
            dropped: 1,
            rawEvidence: 4,
            validEvidence: 2,
            durationMs: 30,
          },
        ],
      }),
    );
    const agg = aggregate([a, b]);
    expect(agg.compression).toBe(8); // (10 + 6) / (1 + 1)
    expect(agg.evidenceRate).toBeCloseTo(5 / 7, 3);
    expect(agg.top1Rate).toBe(1);
    expect(agg.byKind.DISTRACTOR.total).toBe(1);
    expect(agg.passed).toBe(2);
  });

  it('answersOf 把主答案与等价答案合在一起', () => {
    const kase = makeCase({}, { alternatives: [{ category: 'LINK', device: 'ACC-SW-19' }] });
    expect(answersOf(kase)).toHaveLength(2);
  });
});
