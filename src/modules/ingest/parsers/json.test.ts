import { describe, expect, it } from 'vitest';
import { parseJson, parseJsonText } from './json';

const valid = {
  deviceName: 'ACC-SW-01',
  type: 'LINK_DOWN',
  severity: 'P1',
  message: '上联 Down',
  firstSeen: '2026-11-19T10:00:00Z',
};

describe('parseJson', () => {
  it('接受裸数组', () => {
    const { rows, issues } = parseJson([valid]);
    expect(issues).toHaveLength(0);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.firstSeen).toBeInstanceOf(Date);
  });

  it('接受 { alerts: [...] }', () => {
    const { rows } = parseJson({ alerts: [valid, valid] });
    expect(rows).toHaveLength(2);
  });

  it('坏条目按 index 记录并跳过', () => {
    const { rows, issues } = parseJson([valid, { ...valid, severity: 'P9' }, { foo: 1 }]);
    expect(rows).toHaveLength(1);
    expect(issues).toHaveLength(2);
    expect(issues[0]!.index).toBe(1);
    expect(issues[1]!.index).toBe(2);
  });

  it('结构不合法返回 issue 而不是抛异常', () => {
    const { rows, issues } = parseJson({ foo: 'bar' });
    expect(rows).toHaveLength(0);
    expect(issues[0]!.message).toContain('JSON 结构不合法');
  });

  it('JSON 语法错误被兜住', () => {
    const { issues } = parseJsonText('{oops');
    expect(issues[0]!.message).toContain('JSON 解析失败');
  });
});
