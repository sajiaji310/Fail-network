import { describe, expect, it } from 'vitest';
import { parseCsv } from './csv';

const HEAD = 'deviceName,type,severity,message,firstSeen';

describe('parseCsv', () => {
  it('解析正常行，支持引号与逗号', () => {
    const csv = `${HEAD}
ACC-SW-01,LINK_DOWN,P1,"上联 Down, 已确认",2026-11-19T10:00:00Z
ACC-SW-02,CPU_HIGH,P2,CPU 92%,2026-11-19T10:01:00Z`;
    const { rows, issues } = parseCsv(csv);
    expect(issues).toHaveLength(0);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.message).toBe('上联 Down, 已确认');
    expect(rows[1]!.type).toBe('CPU_HIGH');
  });

  it('缺必填列时整体失败并指明列名', () => {
    const { rows, issues } = parseCsv('deviceName,type,severity\nACC-SW-01,LINK_DOWN,P1');
    expect(rows).toHaveLength(0);
    expect(issues[0]!.message).toContain('message');
    expect(issues[0]!.message).toContain('firstSeen');
  });

  it('脏行只跳过该行，行号是文件真实行号', () => {
    const csv = `${HEAD}
ACC-SW-01,LINK_DOWN,P1,正常行,2026-11-19T10:00:00Z
ACC-SW-01,LINK_DOWN,P9,严重度非法,2026-11-19T10:01:00Z
ACC-SW-01,LINK_DOWN,P2,又是正常行,2026-11-19T10:02:00Z`;
    const { rows, issues } = parseCsv(csv);
    expect(rows).toHaveLength(2);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.line).toBe(3);
    expect(issues[0]!.message).toContain('severity');
  });

  it('列数不匹配报错而不是错位赋值', () => {
    const csv = `${HEAD}
ACC-SW-01,LINK_DOWN,P1,少了时间列`;
    const { rows, issues } = parseCsv(csv);
    expect(rows).toHaveLength(0);
    expect(issues[0]!.message).toContain('列数不匹配');
  });

  it('空内容不抛异常', () => {
    const { rows, issues } = parseCsv('   \n  ');
    expect(rows).toHaveLength(0);
    expect(issues[0]!.message).toContain('为空');
  });
});
