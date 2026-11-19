import type { ContextBundle } from './context';
import { ruleFallback } from './fallback';

/**
 * LLM_MOCK=true 时的假模型输出（零网络、零费用跑通全链路）。
 *
 * 刻意做成"真结论 + 一条典型幻觉"：第三条假设引用一个库内不存在的 alertId。
 * 目的不是恶心人，而是让 mock 模式也能把 L1 校验器跑出真实效果 ——
 * 如果 mock 全给正确答案，这条链路在本地永远是绿的，上线才发现校验器根本没生效。
 * 想看不带幻觉的输出，把 LLM_MOCK 关掉走真实调用或 fallback。
 */

const HALLUCINATED_REF = 'alert_mock_0000000000000000';

export function buildMockModelOutput(ctx: ContextBundle): string {
  const base = ruleFallback(ctx);

  const hypotheses = base.hypotheses.map((h) => ({
    cause: h.cause,
    category: h.category,
    confidence: h.confidence,
    evidence: h.evidence.map((e) => ({ type: e.type, ref: e.ref, desc: e.desc })),
    verifySteps: h.verifySteps,
    actions: h.actions,
  }));

  if (hypotheses.length < 3) {
    const anchor = ctx.alerts[0];
    hypotheses.push({
      cause: `${anchor ? anchor.deviceName : '环境中'} 存在未被采集覆盖的隐性故障，由上游设备异常引发`,
      category: 'UPSTREAM',
      confidence: 0.33,
      evidence: [
        {
          type: 'ALERT',
          ref: HALLUCINATED_REF,
          desc: '（mock 构造的幻觉证据，用于演示 L1 丢弃）',
        },
      ],
      verifySteps: ['对照上游设备日志确认是否存在未上报的硬件事件'],
      actions: [{ action: '补充上游设备采集项后重新研判', risk: 'LOW', requiresApproval: false }],
    });
  }

  return JSON.stringify({
    summary: base.summary,
    impactScope: base.impactScope,
    severity: base.severity,
    hypotheses: hypotheses.slice(0, 3),
    missingInfo: base.missingInfo,
  });
}
