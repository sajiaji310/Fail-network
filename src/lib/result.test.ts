import { describe, expect, it } from 'vitest';
import { err, isOk, ok, unwrapOr } from '@/lib/result';

describe('result', () => {
  it('ok 包装值', () => {
    const r = ok(42);
    expect(r.ok).toBe(true);
    expect(isOk(r)).toBe(true);
  });

  it('err 包装错误', () => {
    const r = err('NO_EVIDENCE');
    expect(r.ok).toBe(false);
    expect(isOk(r)).toBe(false);
  });

  it('unwrapOr 在失败时回落', () => {
    expect(unwrapOr(ok('x'), 'fallback')).toBe('x');
    expect(unwrapOr(err('boom'), 'fallback')).toBe('fallback');
  });
});
