import { describe, expect, it } from 'vitest';
import { aggregate, type CaseScore } from './metrics';
import { renderMarkdown } from './report';

const score = (over: Partial<CaseScore> = {}): CaseScore => ({
  id: 'dev-01',
  kind: 'POSITIVE',
  title: '核心线卡故障',
  note: '基线',
  alertTotal: 12,
  incidentTotal: 1,
  expectIncidents: 1,
  precision: 1,
  recall: 1,
  deviceCovered: true,
  rootAlertSuppressed: false,
  top1: true,
  top3: true,
  emptyCorrect: false,
  emptyButExpectedAnswer: false,
  expectAnswer: true,
  hypothesisTotal: 2,
  rawEvidence: 4,
  validEvidence: 6,
  durationMs: 40,
  source: 'RULE_FALLBACK',
  dropped: 0,
  orphanAlerts: 0,
  handlingUnits: 1,
  tokens: 0,
  topologyLevel: 'FULL',
  top1Origin: 'RULE_FALLBACK',
  hintOnlyTop1: false,
  reasoningMs: 0,
  failures: [],
  ...over,
});

describe('评测报告渲染', () => {
  it('输出指标表、分层表与逐场景表', () => {
    const md = renderMarkdown({
      meta: {
        set: 'test',
        mode: 'fallback',
        startedAt: '2026-11-19T12:00:00.000Z',
        durationMs: 3000,
      },
      scores: [score()],
      agg: aggregate([score()]),
    });

    expect(md).toContain('## 评测结果 · test 集');
    expect(md).toContain('`fallback`');
    expect(md).toContain('| Top1 命中率 | 100.0% (1/1) | ≥ 50.0% | ✅ |');
    expect(md).toContain('| 正例 | 1 | 1/1 | 1/1 |');
    expect(md).toContain('dev-01 核心线卡故障');
    expect(md).not.toContain('失败明细');
  });

  it('有失败时输出失败明细与考点', () => {
    const failed = score({
      id: 'dev-13',
      top1: false,
      top3: false,
      failures: ['Top3 未命中标注根因'],
    });
    const md = renderMarkdown({
      meta: {
        set: 'dev',
        mode: 'fallback',
        startedAt: '2026-11-19T12:00:00.000Z',
        durationMs: 1000,
      },
      scores: [failed],
      agg: aggregate([failed]),
    });

    expect(md).toContain('### 失败明细');
    expect(md).toContain('**dev-13**');
    expect(md).toContain('考点：基线');
    expect(md).toContain('| 全通过场景 | 0/1 |');
  });

  it('证据为 0 时显示占位而不是 NaN', () => {
    const md = renderMarkdown({
      meta: { set: 'dev', mode: 'fallback', startedAt: '2026-11-19T12:00:00.000Z', durationMs: 10 },
      scores: [score({ rawEvidence: 0, validEvidence: 0 })],
      agg: aggregate([score({ rawEvidence: 0, validEvidence: 0 })]),
    });
    expect(md).not.toContain('NaN');
    expect(md).toContain('| — |');
  });
});
