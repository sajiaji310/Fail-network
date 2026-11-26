import { describe, expect, it } from 'vitest';
import { parseAlertmanager, parseAmTime, severityOfAlertmanager } from './alertmanager';

const NOW = new Date('2026-11-20T10:00:00Z');

function payload(alerts: unknown[]) {
  return { version: '4', status: 'firing', alerts };
}

function firing(overrides: Record<string, unknown> = {}) {
  return {
    status: 'firing',
    labels: { alertname: 'InterfaceDown', instance: 'CORE-SW-01:9100', severity: 'critical' },
    annotations: { summary: 'Gi0/1 link down' },
    startsAt: '2026-11-20T09:58:00.123456789Z',
    endsAt: '0001-01-01T00:00:00Z',
    fingerprint: 'abc123',
    ...overrides,
  };
}

describe('Alertmanager 适配器', () => {
  it('把 instance 的端口剥掉，映射成平台类型与严重度', () => {
    const { rows, skipped, issues } = parseAlertmanager(payload([firing()]), NOW);
    expect(issues).toHaveLength(0);
    expect(skipped).toBe(0);
    expect(rows).toHaveLength(1);

    const row = rows[0]!;
    expect(row.deviceName).toBe('CORE-SW-01');
    // "InterfaceDown" 归到更具体的端口级故障；链路级的 "LinkDown" 见下一条用例
    expect(row.type).toBe('PORT_DOWN');
    expect(row.severity).toBe('P1');
    expect(row.message).toBe('Gi0/1 link down');
    expect(row.externalKey).toBe('am:abc123|2026-11-20T09:58:00.123Z');
    expect(row.state).toBe('FIRING');
    expect(row.refreshOnDuplicate).toBe(true);
    expect(row.firstSeen.toISOString()).toBe('2026-11-20T09:58:00.123Z');
    // 零值 endsAt 不能被当成真实恢复时间；firing 的 lastSeen 用接收时间
    expect(row.lastSeen?.toISOString()).toBe(NOW.toISOString());
  });

  it('链路级标题归到 LINK_DOWN', () => {
    const { rows } = parseAlertmanager(
      payload([firing({ labels: { alertname: 'LinkDown', instance: 'CORE-SW-01:9100' } })]),
      NOW,
    );
    expect(rows[0]!.type).toBe('LINK_DOWN');
  });

  it('resolved 进入导入行，外部键仍按 fingerprint + startsAt', () => {
    const { rows, skipped } = parseAlertmanager(
      payload([firing({ status: 'resolved', endsAt: '2026-11-20T09:59:00Z' })]),
      NOW,
    );
    expect(skipped).toBe(0);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe('RESOLVED');
    expect(rows[0]!.externalKey).toBe('am:abc123|2026-11-20T09:58:00.123Z');
    expect(rows[0]!.lastSeen?.toISOString()).toBe('2026-11-20T09:59:00.000Z');
  });

  it('顶层 status=resolved 且单条没写 status 时，也按恢复处理', () => {
    const { rows } = parseAlertmanager(
      { version: '4', status: 'resolved', alerts: [firing({ status: undefined })] },
      NOW,
    );
    expect(rows[0]!.state).toBe('RESOLVED');
  });

  it('firing 的非零 endsAt 不写入 lastSeen', () => {
    const { rows } = parseAlertmanager(payload([firing({ endsAt: '2026-11-20T12:00:00Z' })]), NOW);
    expect(rows[0]!.lastSeen?.toISOString()).toBe(NOW.toISOString());
    expect(rows[0]!.raw).toMatchObject({ endsAt: '2026-11-20T12:00:00Z' });
  });

  it('缺 instance 的告警进 issues，同批其它行照常导入', () => {
    const { rows, issues } = parseAlertmanager(
      payload([firing({ labels: { alertname: 'X', severity: 'warning' } }), firing()]),
      NOW,
    );
    expect(rows).toHaveLength(1);
    expect(issues[0]?.message).toContain('instance');
  });

  it('annotations 里的 value/threshold 会被解析成数字', () => {
    const { rows } = parseAlertmanager(
      payload([
        firing({
          annotations: { summary: 'CPU 高', value: '91.5%', threshold: '80%' },
          labels: { alertname: 'HighCPU', instance: 'AGG-SW-01:9100', severity: 'warning' },
        }),
      ]),
      NOW,
    );
    expect(rows[0]!.value).toBe(91.5);
    expect(rows[0]!.threshold).toBe(80);
    expect(rows[0]!.type).toBe('CPU_HIGH');
  });

  it('未知告警名保留规范化原名，而不是塞成 OTHER', () => {
    const { rows } = parseAlertmanager(
      payload([firing({ labels: { alertname: 'Something Weird!', instance: 'ACC-SW-01:9100' } })]),
      NOW,
    );
    expect(rows[0]!.type).toBe('SOMETHING_WEIRD');
  });

  it('payload 结构不合法时返回 issues 而不是抛异常', () => {
    const { rows, issues } = parseAlertmanager({ alerts: 'nope' }, NOW);
    expect(rows).toHaveLength(0);
    expect(issues.length).toBeGreaterThan(0);
  });
});

describe('Alertmanager 时间与严重度映射', () => {
  it('纳秒精度裁到毫秒；零值与非法值返回 null', () => {
    expect(parseAmTime('2026-11-20T09:58:00.123456789Z')?.toISOString()).toBe(
      '2026-11-20T09:58:00.123Z',
    );
    expect(parseAmTime('0001-01-01T00:00:00Z')).toBeNull();
    expect(parseAmTime('not-a-date')).toBeNull();
    expect(parseAmTime(undefined)).toBeNull();
  });

  it('字面映射严重度，认不出来按 P2', () => {
    expect(severityOfAlertmanager('critical')).toBe('P1');
    expect(severityOfAlertmanager('emergency')).toBe('P0');
    expect(severityOfAlertmanager('P3')).toBe('P3');
    expect(severityOfAlertmanager('weird-level')).toBe('P2');
    expect(severityOfAlertmanager(undefined)).toBe('P2');
  });
});
