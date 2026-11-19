import { describe, expect, it } from 'vitest';
import { AppError } from '@/lib/errors';
import type { IncidentStatus } from '@prisma/client';
import {
  canTransition,
  INCIDENT_STATUS_ORDER,
  INCIDENT_TRANSITIONS,
  isTerminal,
  nextStatuses,
} from './stateMachine';
import { assertTransition } from './stateMachine';

/**
 * AC-08：RESOLVED 回退到 OPEN 必须 409 INVALID_TRANSITION。
 * 其余用例锁住"只向前、允许跳级、终态不动"三条规则 —— 状态机是审计的地基。
 */

const ALL: IncidentStatus[] = [...INCIDENT_STATUS_ORDER];

describe('AC-08 事件状态机', () => {
  it('RESOLVED → OPEN 抛 409 INVALID_TRANSITION（AC-08 原文场景）', () => {
    expect(canTransition('RESOLVED', 'OPEN')).toBe(false);
    try {
      assertTransition('RESOLVED', 'OPEN');
      throw new Error('应当抛错');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      const appError = error as AppError;
      expect(appError.code).toBe('INVALID_TRANSITION');
      expect(appError.status).toBe(409);
      expect(appError.details).toMatchObject({ from: 'RESOLVED', to: 'OPEN' });
    }
  });

  it('每条非终态都至少有一个后继，且只能指向更靠后的状态', () => {
    for (const from of ALL) {
      for (const to of INCIDENT_TRANSITIONS[from]) {
        expect(INCIDENT_STATUS_ORDER.indexOf(to)).toBeGreaterThan(
          INCIDENT_STATUS_ORDER.indexOf(from),
        );
      }
    }
  });

  it('允许跳级：OPEN 可直接 RESOLVED（小故障不逼着走流程）', () => {
    expect(canTransition('OPEN', 'RESOLVED')).toBe(true);
    expect(canTransition('ANALYZING', 'RESOLVED')).toBe(true);
    expect(canTransition('OPEN', 'CLOSED')).toBe(false);
  });

  it('禁止任何回退：LOCATED → ANALYZING 也不允许', () => {
    expect(canTransition('LOCATED', 'ANALYZING')).toBe(false);
    expect(canTransition('MITIGATED', 'LOCATED')).toBe(false);
    expect(() => assertTransition('LOCATED', 'ANALYZING')).toThrow(AppError);
  });

  it('RESOLVED 只能归档，CLOSED 是终态', () => {
    expect(nextStatuses('RESOLVED')).toEqual(['CLOSED']);
    expect(isTerminal('RESOLVED')).toBe(false);
    expect(nextStatuses('CLOSED')).toEqual([]);
    expect(isTerminal('CLOSED')).toBe(true);
    expect(() => assertTransition('CLOSED', 'CLOSED')).toThrow(AppError);
  });

  it('同状态不算合法流转（幂等在调用方短路，不能靠状态机放过）', () => {
    for (const status of ALL) {
      expect(canTransition(status, status)).toBe(false);
    }
  });

  it('错误信息带中文状态名，便于直接展示给值班同学', () => {
    try {
      assertTransition('CLOSED', 'OPEN');
    } catch (error) {
      expect((error as AppError).message).toContain('已归档');
      expect((error as AppError).details).toMatchObject({ reason: 'TERMINAL' });
    }
  });
});
