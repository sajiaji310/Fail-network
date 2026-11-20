import { describe, expect, it } from 'vitest';
import { assessResponse, derivePhase, slaMinutesOf, type ResponseInput } from './sla';

/**
 * 响应时限与阶段判定（评审第 3 阶段）。
 *
 * 纯函数测试，不碰库：这两个判定会同时出现在概览队列、事件列表、详情页头，
 * 一旦口径漂移，三个地方会给出互相矛盾的结论。
 */

const START = new Date('2026-11-20T10:00:00Z');
const at = (minutes: number) => new Date(START.getTime() + minutes * 60_000);

const base: ResponseInput = {
  severity: 'P1',
  status: 'OPEN',
  startedAt: START,
  claimedAt: null,
  slaMinutes: null,
};

describe('slaMinutesOf', () => {
  it('没有快照时按严重级取默认目标', () => {
    expect(slaMinutesOf({ severity: 'P0', slaMinutes: null })).toBe(10);
    expect(slaMinutesOf({ severity: 'P3', slaMinutes: null })).toBe(240);
  });

  it('事件自己的快照优先：策略收紧不追溯改变历史判定', () => {
    // P0 现在的目标是 10 分钟，但这条事件创建时策略是 30 分钟
    expect(slaMinutesOf({ severity: 'P0', slaMinutes: 30 })).toBe(30);
  });
});

describe('assessResponse', () => {
  it('未接手且在时限内 → UNASSIGNED', () => {
    const r = assessResponse(base, at(1));
    expect(r.state).toBe('UNASSIGNED');
    expect(r.remainingSeconds).toBe(19 * 60);
    expect(r.claimSeconds).toBeNull();
  });

  it('剩余不足两成 → DUE_SOON', () => {
    // P1 目标 20 分钟，剩 3 分钟 = 15%
    const r = assessResponse(base, at(17));
    expect(r.state).toBe('DUE_SOON');
  });

  it('到点未接手 → BREACHED', () => {
    const r = assessResponse(base, at(21));
    expect(r.state).toBe('BREACHED');
    expect(r.remainingSeconds).toBeLessThan(0);
  });

  it('时限内接手 → WITHIN，并算出响应耗时', () => {
    const r = assessResponse({ ...base, claimedAt: at(8) }, at(60));
    expect(r.state).toBe('WITHIN');
    expect(r.claimSeconds).toBe(8 * 60);
  });

  it('接手晚于目标 → BREACHED（接手之后不再变回正常）', () => {
    const r = assessResponse({ ...base, claimedAt: at(35) }, at(36));
    expect(r.state).toBe('BREACHED');
    expect(r.claimSeconds).toBe(35 * 60);
  });

  it('已结束的事件统一 SETTLED，不再挂在值班面板上', () => {
    const r = assessResponse({ ...base, status: 'RESOLVED', claimedAt: at(5) }, at(600));
    expect(r.state).toBe('SETTLED');
    // 但 MTTA 数据仍保留
    expect(r.claimSeconds).toBe(5 * 60);
  });
});

describe('derivePhase', () => {
  const p = (patch: Partial<Parameters<typeof derivePhase>[0]>) =>
    derivePhase({
      status: 'OPEN',
      assignee: null,
      hasAnalysis: false,
      hasAccepted: false,
      ...patch,
    });

  it('没人接手就是待接手，哪怕已经有结论', () => {
    expect(p({ hasAnalysis: true })).toBe('UNASSIGNED');
  });

  it('已接手 + 有结论但没人采纳 → 待确认', () => {
    expect(p({ assignee: '陈昊', hasAnalysis: true })).toBe('AWAITING_CONFIRM');
  });

  it('已接手 + 已采纳 → 分析中（等人推进状态）', () => {
    expect(p({ assignee: '陈昊', hasAnalysis: true, hasAccepted: true })).toBe('INVESTIGATING');
  });

  it('状态优先于派生的中间阶段', () => {
    expect(p({ status: 'LOCATED', assignee: null })).toBe('LOCATED');
    expect(p({ status: 'MITIGATED' })).toBe('MITIGATED');
    expect(p({ status: 'RESOLVED' })).toBe('RESOLVED');
    expect(p({ status: 'CLOSED' })).toBe('ARCHIVED');
  });
});
