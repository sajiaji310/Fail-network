import { afterEach, describe, expect, it } from 'vitest';
import { env } from '@/lib/env';
import { makeContext } from './test-utils';
import { PROMPT_VERSION, renderPrompt, SYSTEM_PROMPT } from './prompt';

/**
 * 提示词单测（Spec §3.2 / 验收标准 6）。
 *
 * 只在文本层面断言"该出现的东西出现了、该消失的东西消失了"：
 * 不模拟模型、不判断归因对不对 —— 那是评测集的事。这里锁的是两条回滚路径
 * （RCA_HINT / RCA_SIGNALS）真的能改到渲染结果，否则"关掉开关"只是一句承诺。
 */

const savedHint = env.RCA_HINT;
const savedSignals = env.RCA_SIGNALS;

afterEach(() => {
  env.RCA_HINT = savedHint;
  env.RCA_SIGNALS = savedSignals;
});

const ctx = makeContext();

/** 每条告警行都以 "- <id> |" 开头，用它把告警行挑出来 */
function alertLines(prompt: string): string[] {
  return prompt
    .split('\n')
    .filter((line) => line.startsWith('- alert-'))
    .map((line) => line);
}

describe('归因字典注入', () => {
  it('RCA_HINT=on 时每条告警行都带「归因:」，未登记类型写「未登记」', () => {
    env.RCA_HINT = 'on';
    const unknownCtx = {
      ...ctx,
      alerts: [
        ...ctx.alerts,
        {
          ...ctx.alerts[0]!,
          id: 'alert-unknown',
          type: 'UNKNOWN_SENSOR_A',
          alertClass: 'UNKNOWN' as const,
        },
      ],
    };
    const lines = alertLines(renderPrompt(unknownCtx).user);
    expect(lines.length).toBe(unknownCtx.alerts.length);
    for (const line of lines) expect(line).toContain('| 归因:');
    expect(lines.find((l) => l.includes('UNKNOWN_SENSOR_A'))).toContain('| 归因:未登记');
    expect(lines.find((l) => l.includes('LINECARD_FAILURE'))).toContain('| 归因:HARDWARE');
  });

  it('RCA_HINT=off 时整段上下文里不出现「归因:」标签（回滚路径）', () => {
    env.RCA_HINT = 'off';
    const user = renderPrompt(ctx).user;
    const tagLines = alertLines(user).filter((line) => line.includes('归因:'));
    expect(tagLines).toHaveLength(0);
    // 段头说明也要一起撤掉，否则模型仍被口头要求用归因
    expect(user).not.toContain('行尾「归因」');
  });

  it('告警段头说明"归因不指示根因在哪台设备"（冲突时的处置口径）', () => {
    env.RCA_HINT = 'on';
    const user = renderPrompt(ctx).user;
    expect(user).toContain('不指示根因在哪台设备');
    expect(user).toContain('以证据为准');
  });

  it('SYSTEM_PROMPT 第 6 条允许覆盖归因但要求写明理由', () => {
    expect(SYSTEM_PROMPT).toContain('6. category 字段优先采用告警行尾的归因标签');
    expect(SYSTEM_PROMPT).toContain('必须在 evidence.desc 中写明偏离理由');
  });

  it('SYSTEM_PROMPT 写明输出体量（与 schema 收紧同步）', () => {
    expect(SYSTEM_PROMPT).toContain('evidence 最多 3 条');
    expect(SYSTEM_PROMPT).toContain('不超过 80 字');
    expect(SYSTEM_PROMPT).toContain('actions 最多 1 条');
  });

  it('PROMPT_VERSION 已升到 rca-1.1（落库可比对）', () => {
    expect(PROMPT_VERSION).toBe('rca-1.1');
  });
});

describe('上下文瘦身（§3.5）', () => {
  it('历史案例只渲染 title + tags，不再铺现象/根因/处置', () => {
    const user = renderPrompt(ctx).user;
    expect(user).toContain('case-power');
    expect(user).toContain('tags：硬件/电源');
    expect(user).not.toContain('现象：');
    expect(user).not.toContain('处置：');
  });

  it('指标趋势最多展开 3 条，其余只留 ref 与「有采样曲线」', () => {
    const trend = {
      samples: 6,
      first: 10,
      last: 90,
      min: 10,
      max: 90,
      slopePerMin: 12.5,
      from: '2026-11-19T01:30:00.000Z',
      to: '2026-11-19T02:00:00.000Z',
    };
    const metrics = Array.from({ length: 5 }, (_, i) => ({
      ref: `metric:ACC-SW-0${i}:cpu`,
      deviceId: 'dev-acc7',
      deviceName: `ACC-SW-0${i}`,
      metric: 'cpu.util',
      value: 80,
      threshold: 70,
      unit: '%',
      at: '2026-11-19T02:00:00.000Z',
      source: 'SAMPLE' as const,
      trend,
    }));
    const user = renderPrompt({ ...ctx, metrics }).user;
    expect(user.match(/趋势：/g)).toHaveLength(3);
    expect(user).toContain('另有 2 条指标有采样曲线');
  });
});

describe('设备信号（B 组消融，默认关闭）', () => {
  it('RCA_SIGNALS=off 时不渲染设备信号段', () => {
    env.RCA_SIGNALS = 'off';
    expect(renderPrompt(ctx).user).not.toContain('[设备信号]');
  });

  it('RCA_SIGNALS=on 时渲染事实统计，且不含评分/排序字样', () => {
    env.RCA_SIGNALS = 'on';
    const user = renderPrompt(ctx).user;
    expect(user).toContain('[设备信号]');
    expect(user).toContain('AGG-SW-02');
    expect(user).toContain('事件前有变更');
    expect(user).not.toContain('分数');
  });
});
