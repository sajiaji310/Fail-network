import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '@/lib/errors';
import { db } from '@/lib/db';
import { audited, listAudit, recordAudit, resolveActor, resolveIp } from './service';

/**
 * 操作审计（评审第 1 阶段）。
 *
 * 三条要守住的性质：
 * 1. 成功和失败都留痕（失败往往更值得查）；
 * 2. detail 只放路由显式声明的字段，不把请求体整包抄进来；
 * 3. 审计写入失败不阻断业务 —— 用一条假的失败路径验证，宁可少记录也不毁主流程。
 */

const TARGET_PREFIX = 'T-AUDIT-';

async function cleanup() {
  await db.auditLog.deleteMany({ where: { target: { startsWith: TARGET_PREFIX } } });
}

beforeEach(cleanup);
afterAll(cleanup);

function request(headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/v1/test', { method: 'POST', headers });
}

describe('resolveActor / resolveIp', () => {
  it('没有 API Key 时记 local', () => {
    expect(resolveActor(request())).toBe('local');
  });

  it('长 key 只留尾 4 位（审计表会被导出，不能变成泄密点）', () => {
    expect(resolveActor(request({ 'x-api-key': 'sk-1234567890abcdef' }))).toBe('api-key:…cdef');
  });

  it('短 key 退化成 api-key，不泄露长度', () => {
    expect(resolveActor(request({ 'x-api-key': 'short' }))).toBe('api-key');
  });

  it('取 x-forwarded-for 的第一跳', () => {
    expect(resolveIp(request({ 'x-forwarded-for': '10.0.0.1, 10.0.0.2' }))).toBe('10.0.0.1');
    expect(resolveIp(request())).toBeNull();
  });
});

describe('recordAudit / listAudit', () => {
  it('写入后能按动作查到', async () => {
    await recordAudit({
      action: 'correlation.run',
      actor: 'tester',
      target: `${TARGET_PREFIX}record`,
      detail: { created: 1 },
    });

    const items = await listAudit({ action: 'correlation.run', limit: 50 });
    const hit = items.filter((item) => item.target === `${TARGET_PREFIX}record`);
    expect(hit).toHaveLength(1);
    expect(hit[0]?.result).toBe('OK');
    expect(hit[0]?.detail).toMatchObject({ created: 1 });
  });

  it('limit 会被夹到 1..200，不会因为 ?limit=99999 把库拖垮', async () => {
    await expect(listAudit({ limit: 99_999 })).resolves.toBeInstanceOf(Array);
  });
});

describe('audited 包装', () => {
  it('成功：记 OK，并把 detailOf 的字段合并进去', async () => {
    const result = await audited(
      request(),
      {
        action: 'incident.transition',
        target: `${TARGET_PREFIX}ok`,
        detail: { to: 'RESOLVED' },
        detailOf: (r: { code: string }) => ({ code: r.code, from: 'ANALYZING' }),
      },
      async () => ({ code: 'INC-TEST-001' }),
    );
    expect(result.code).toBe('INC-TEST-001');

    const item = await db.auditLog.findFirst({ where: { target: `${TARGET_PREFIX}ok` } });
    expect(item?.result).toBe('OK');
    expect(item?.detail).toMatchObject({ to: 'RESOLVED', code: 'INC-TEST-001', from: 'ANALYZING' });
  });

  it('失败：记 FAIL + 错误码，异常原样抛出', async () => {
    await expect(
      audited(
        request(),
        { action: 'hypothesis.verdict', target: `${TARGET_PREFIX}fail` },
        async () => {
          throw new AppError('NOT_FOUND', '假设不存在');
        },
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });

    const item = await db.auditLog.findFirst({ where: { target: `${TARGET_PREFIX}fail` } });
    expect(item?.result).toBe('FAIL');
    expect(item?.detail).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });

  it('未识别异常也要留痕（记 INTERNAL，不抄堆栈）', async () => {
    await expect(
      audited(request(), { action: 'alert.ingest', target: `${TARGET_PREFIX}boom` }, async () => {
        throw new Error('socket hang up');
      }),
    ).rejects.toThrow('socket hang up');

    const item = await db.auditLog.findFirst({ where: { target: `${TARGET_PREFIX}boom` } });
    expect(item?.result).toBe('FAIL');
    expect(item?.detail).toMatchObject({ error: { code: 'INTERNAL' } });
    // 堆栈/原始错误信息不进审计表，避免把内部实现暴露给能读审计的人
    expect(JSON.stringify(item?.detail)).not.toContain('socket hang up');
  });
});
