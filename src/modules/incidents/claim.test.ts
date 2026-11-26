import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { AppError } from '@/lib/errors';
import { claimIncident, releaseIncident } from './claim';

/**
 * 接手 / 转派 / 释放（评审 5.3）。
 *
 * 重点不是"能写进去"，而是三条约束：
 * 1. 抢单要被拦住（409 + 当前责任人），而不是静默覆盖；
 * 2. 转派不重置 claimedAt —— 否则换个值班人 MTTA 就洗成 0；
 * 3. 已结束的事件不能再变更处理人。
 */

const BASE = new Date('2026-11-12T02:00:00Z');
const min = (n: number) => new Date(BASE.getTime() + n * 60_000);

let seq = 0;

async function makeIncident(
  patch: Partial<{
    status: 'OPEN' | 'RESOLVED';
    assignee: string;
    claimedAt: Date;
    sla: number;
  }> = {},
): Promise<string> {
  seq++;
  const row = await db.incident.create({
    data: {
      code: `INC-20261112-9${String(seq).padStart(2, '0')}`,
      title: '接手测试事件',
      status: patch.status ?? 'OPEN',
      severity: 'P1',
      startedAt: BASE,
      lastSeen: BASE,
      assignee: patch.assignee ?? null,
      claimedAt: patch.claimedAt ?? null,
      slaMinutes: patch.sla ?? null,
    },
    select: { id: true },
  });
  return row.id;
}

async function cleanup() {
  await db.incident.deleteMany({ where: { code: { startsWith: 'INC-20261112-9' } } });
}

beforeEach(cleanup);
afterAll(cleanup);

describe('claimIncident', () => {
  it('首次接手写入负责人、团队与响应耗时', async () => {
    const id = await makeIncident();
    const result = await claimIncident({
      idOrCode: id,
      assignee: '陈昊',
      team: '网络组',
      now: min(6),
    });

    expect(result).not.toBeNull();
    expect(result!.assignee).toBe('陈昊');
    expect(result!.previousAssignee).toBeNull();
    expect(result!.claimSeconds).toBe(6 * 60);
    expect(result!.withinSla).toBe(true); // P1 目标 20 分钟

    const row = await db.incident.findUniqueOrThrow({
      where: { id },
      select: { assignee: true, team: true, claimedAt: true, slaMinutes: true },
    });
    expect(row.assignee).toBe('陈昊');
    expect(row.team).toBe('网络组');
    expect(row.claimedAt?.toISOString()).toBe(min(6).toISOString());
    // 创建时没有快照的旧数据，接手时补上
    expect(row.slaMinutes).toBe(20);
  });

  it('已被他人接手时拒绝，并带上当前责任人', async () => {
    const id = await makeIncident({ assignee: '陈昊', claimedAt: min(3) });

    await expect(claimIncident({ idOrCode: id, assignee: '李锐', now: min(9) })).rejects.toThrow(
      AppError,
    );

    try {
      await claimIncident({ idOrCode: id, assignee: '李锐', now: min(9) });
    } catch (error) {
      const err = error as AppError;
      expect(err.code).toBe('ALREADY_CLAIMED');
      expect(err.status).toBe(409);
      expect((err.details as { assignee: string }).assignee).toBe('陈昊');
    }
  });

  it('force 转派成功，但不重置响应时间', async () => {
    const id = await makeIncident({ assignee: '陈昊', claimedAt: min(3) });

    const result = await claimIncident({
      idOrCode: id,
      assignee: '李锐',
      team: '网络组',
      force: true,
      now: min(40),
    });

    expect(result!.previousAssignee).toBe('陈昊');
    // 仍是第一次接手的时间与耗时：转派不洗 MTTA
    expect(result!.claimedAt).toBe(min(3).toISOString());
    expect(result!.claimSeconds).toBe(3 * 60);
  });

  it('已结束的事件不能再变更处理人', async () => {
    const id = await makeIncident({ status: 'RESOLVED', assignee: '陈昊', claimedAt: min(2) });

    try {
      await claimIncident({ idOrCode: id, assignee: '李锐', force: true, now: min(60) });
      throw new Error('应当抛错');
    } catch (error) {
      expect((error as AppError).code).toBe('INCIDENT_CLOSED');
      expect((error as AppError).status).toBe(409);
    }
  });

  it('同一个人的重复接手不算抢单', async () => {
    const id = await makeIncident({ assignee: '陈昊', claimedAt: min(3) });
    const result = await claimIncident({ idOrCode: id, assignee: '陈昊', now: min(5) });
    expect(result!.previousAssignee).toBe('陈昊');
  });

  it('空接手人直接拒绝', async () => {
    const id = await makeIncident();
    await expect(claimIncident({ idOrCode: id, assignee: '   ' })).rejects.toThrow(AppError);
  });
});

describe('releaseIncident', () => {
  it('释放后回到无人接手，但保留 claimedAt 供 MTTA 统计', async () => {
    const id = await makeIncident({ assignee: '陈昊', claimedAt: min(4) });

    const result = await releaseIncident({ idOrCode: id });
    expect(result!.releasedAssignee).toBe('陈昊');

    const row = await db.incident.findUniqueOrThrow({
      where: { id },
      select: { assignee: true, team: true, claimedAt: true },
    });
    expect(row.assignee).toBeNull();
    expect(row.team).toBeNull();
    expect(row.claimedAt?.toISOString()).toBe(min(4).toISOString());
  });

  it('本来没人接手时是幂等空操作', async () => {
    const id = await makeIncident();
    const result = await releaseIncident({ idOrCode: id });
    expect(result!.releasedAssignee).toBeNull();
  });

  it('别的租户按同一事件 ID 接手，当作不存在', async () => {
    const id = await makeIncident();
    const result = await claimIncident({
      idOrCode: id,
      assignee: '外租户',
      tenantId: 'other-tenant',
    });
    expect(result).toBeNull();
    const row = await db.incident.findUniqueOrThrow({ where: { id }, select: { assignee: true } });
    expect(row.assignee).toBeNull();
  });
});
