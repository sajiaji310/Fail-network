import { describe, expect, it } from 'vitest';
import { parseZabbix, severityOfZabbix, zabbixItems, zabbixTime } from './zabbix';

const NOW = new Date('2026-11-20T10:00:00Z');

describe('Zabbix 适配器', () => {
  it('单条事件对象直接可解析', () => {
    const { rows, issues } = parseZabbix(
      {
        host: 'CORE-SW-01',
        trigger: 'Interface Gi0/1 link down',
        severity: 4,
        eventid: '10086',
        clock: 1795168800,
      },
      NOW,
    );
    expect(issues).toHaveLength(0);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.deviceName).toBe('CORE-SW-01');
    expect(rows[0]!.type).toBe('LINK_DOWN');
    expect(rows[0]!.severity).toBe('P1');
    expect(rows[0]!.externalKey).toBe('zbx:10086');
    expect(rows[0]!.firstSeen.toISOString()).toBe('2026-11-20T10:00:00.000Z');
  });

  it('{problems:[...]} 与裸数组都认', () => {
    const item = { host: 'AGG-SW-01', trigger: 'CPU high', severity: 2, eventid: 'a' };
    expect(parseZabbix({ problems: [item] }, NOW).rows).toHaveLength(1);
    expect(parseZabbix([item, { ...item, eventid: 'b' }], NOW).rows).toHaveLength(2);
  });

  it('severity 0–5 与文本两种口径都能映射', () => {
    expect(severityOfZabbix({ severity: 0 })).toBe('P3');
    expect(severityOfZabbix({ severity: 3 })).toBe('P2');
    expect(severityOfZabbix({ severity: 5 })).toBe('P0');
    expect(severityOfZabbix({ severity: 'Disaster' })).toBe('P0');
    expect(severityOfZabbix({ severity: 'High' })).toBe('P1');
    expect(severityOfZabbix({})).toBe('P2');
  });

  it('恢复事件计入 skipped', () => {
    const { rows, skipped } = parseZabbix(
      { host: 'CORE-SW-01', trigger: 'x', status: 'RESOLVED', eventid: '1' },
      NOW,
    );
    expect(rows).toHaveLength(0);
    expect(skipped).toBe(1);
  });

  it('缺 host 进 issues，不整体失败', () => {
    const { rows, issues } = parseZabbix({ trigger: 'x', severity: 3 }, NOW);
    expect(rows).toHaveLength(0);
    expect(issues[0]?.message).toContain('host');
  });

  it('设备名里的端口也会被剥掉', () => {
    const { rows } = parseZabbix({ host: 'ACC-SW-01:10050', trigger: 'x' }, NOW);
    expect(rows[0]!.deviceName).toBe('ACC-SW-01');
  });

  it('超过 5000 条直接打回，避免拖死单次请求', () => {
    const many = Array.from({ length: 5001 }, (_, i) => ({
      host: 'A',
      trigger: 'x',
      eventid: `${i}`,
    }));
    const { rows, issues } = parseZabbix(many, NOW);
    expect(rows).toHaveLength(0);
    expect(issues[0]?.message).toContain('5000');
  });
});

describe('Zabbix 时间解析', () => {
  it('clock 秒 / 毫秒 / eventDate+eventTime 都能转', () => {
    expect(zabbixTime({ clock: 1795168800 }, NOW).toISOString()).toBe('2026-11-20T10:00:00.000Z');
    expect(zabbixTime({ clock: 1795168800000 }, NOW).toISOString()).toBe(
      '2026-11-20T10:00:00.000Z',
    );
    expect(zabbixTime({ eventDate: '2026.11.20', eventTime: '09:30:00' }, NOW).getHours()).toBe(9);
    expect(zabbixTime({}, NOW)).toEqual(NOW);
  });

  it('条目提取：数组 / problems / 单对象', () => {
    expect(zabbixItems([{ a: 1 }])).toHaveLength(1);
    expect(zabbixItems({ problems: [{ a: 1 }, { a: 2 }] })).toHaveLength(2);
    expect(zabbixItems({ host: 'x' })).toHaveLength(1);
    expect(zabbixItems('nope')).toBeNull();
  });
});
