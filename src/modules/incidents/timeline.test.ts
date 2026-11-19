import { describe, expect, it } from 'vitest';
import { buildTimeline, changeKindLabel, type TimelineInput } from './timeline';

const at = (iso: string) => new Date(iso);

function baseInput(overrides: Partial<TimelineInput> = {}): TimelineInput {
  return {
    incident: {
      id: 'inc-1',
      code: 'INC-20261119-001',
      title: 'CORE-SW-01 线卡故障',
      startedAt: at('2026-11-19T10:00:00Z'),
      lastSeen: at('2026-11-19T10:20:00Z'),
      resolvedAt: null,
    },
    alerts: [],
    changes: [],
    ...overrides,
  };
}

describe('buildTimeline', () => {
  it('事件开始在最前，告警按时间升序', () => {
    const result = buildTimeline(
      baseInput({
        alerts: [
          {
            id: 'a2',
            type: 'BGP_NEIGHBOR_DOWN',
            severity: 'P1',
            status: 'ACTIVE',
            message: 'BGP 邻居 10.0.0.2 Down',
            count: 1,
            firstSeen: at('2026-11-19T10:08:00Z'),
            deviceId: 'core',
            deviceName: 'CORE-SW-01',
          },
          {
            id: 'a1',
            type: 'LINECARD_FAILURE',
            severity: 'P0',
            status: 'ACTIVE',
            message: 'Slot 3 线卡故障',
            count: 1,
            firstSeen: at('2026-11-19T10:00:00Z'),
            deviceId: 'core',
            deviceName: 'CORE-SW-01',
          },
        ],
      }),
    );

    expect(result.items.map((i) => i.kind)).toEqual(['INCIDENT', 'ALERT', 'ALERT']);
    expect(result.items[1]?.title).toBe('CORE-SW-01 · 线卡故障');
    expect(result.items[2]?.title).toBe('CORE-SW-01 · BGP 邻居 Down');
    expect(result.truncated).toBe(false);
  });

  it('被抑制的告警归为 SUPPRESS，并在详情里标注不计入影响面', () => {
    const result = buildTimeline(
      baseInput({
        alerts: [
          {
            id: 'a1',
            type: 'CPU_HIGH',
            severity: 'P2',
            status: 'SUPPRESSED',
            message: 'CPU 96%',
            count: 3,
            firstSeen: at('2026-11-19T10:03:00Z'),
            deviceId: 'core',
            deviceName: 'CORE-SW-01',
          },
        ],
      }),
    );

    const item = result.items.find((i) => i.id === 'alert-a1');
    expect(item?.kind).toBe('SUPPRESS');
    expect(item?.detail).toContain('被父告警抑制');
    // 抑制项不隐藏累计次数
    expect(item?.detail).toContain('CPU 96%');
  });

  it('变更记录进时间线，并带上操作人', () => {
    const result = buildTimeline(
      baseInput({
        changes: [
          {
            id: 'chg-1',
            kind: 'CONFIG',
            content: 'ACL 3000 顺序调整',
            operator: 'zhangwei',
            changedAt: at('2026-11-19T09:58:00Z'),
            deviceId: 'fw',
            deviceName: 'FW-01',
          },
        ],
      }),
    );

    const item = result.items.find((i) => i.kind === 'CHANGE');
    expect(item?.title).toBe('FW-01 · 配置变更');
    expect(item?.detail).toContain('操作人 zhangwei');
    // 早于事件开始的变更仍然排在最前（这是"故障前动过什么"的关键证据）
    expect(result.items[0]?.kind).toBe('CHANGE');
  });

  it('同一时刻的排序：事件 → 变更 → 告警', () => {
    const t = '2026-11-19T10:00:00Z';
    const result = buildTimeline(
      baseInput({
        alerts: [
          {
            id: 'a1',
            type: 'LINK_DOWN',
            severity: 'P1',
            status: 'ACTIVE',
            message: 'Gi1/0/1 Down',
            count: 1,
            firstSeen: at(t),
            deviceId: 'acc',
            deviceName: 'ACC-SW-01',
          },
        ],
        changes: [
          {
            id: 'chg-1',
            kind: 'CABLING',
            content: '更换跳线',
            operator: null,
            changedAt: at(t),
            deviceId: 'acc',
            deviceName: 'ACC-SW-01',
          },
        ],
      }),
    );

    expect(result.items.map((i) => i.kind)).toEqual(['INCIDENT', 'CHANGE', 'ALERT']);
  });

  it('已恢复事件追加恢复节点，且排在最后', () => {
    const result = buildTimeline(
      baseInput({
        incident: {
          id: 'inc-1',
          code: 'INC-20261119-001',
          title: 'x',
          startedAt: at('2026-11-19T10:00:00Z'),
          lastSeen: at('2026-11-19T10:20:00Z'),
          resolvedAt: at('2026-11-19T11:00:00Z'),
        },
      }),
    );

    expect(result.items.at(-1)?.title).toBe('事件恢复');
    expect(result.items.at(-1)?.at).toBe('2026-11-19T11:00:00.000Z');
  });

  it('超过上限截断，但 total 保留真实条数', () => {
    const alerts = Array.from({ length: 12 }, (_, i) => ({
      id: `a${i}`,
      type: 'PACKET_LOSS',
      severity: 'P2' as const,
      status: 'ACTIVE' as const,
      message: `丢包 ${i}`,
      count: 1,
      firstSeen: at(`2026-11-19T10:${String(i).padStart(2, '0')}:00Z`),
      deviceId: 'acc',
      deviceName: 'ACC-SW-01',
    }));

    const result = buildTimeline(baseInput({ alerts }), { limit: 5 });
    expect(result.items).toHaveLength(5);
    expect(result.total).toBe(13);
    expect(result.truncated).toBe(true);
    // 截断保留最早的事件，RCA 需要的是开头
    expect(result.items[0]?.kind).toBe('INCIDENT');
  });

  it('时间线里所有时间都是 ISO 字符串（可跨 RSC 边界）', () => {
    const result = buildTimeline(baseInput());
    for (const item of result.items) {
      expect(typeof item.at).toBe('string');
      expect(Number.isNaN(Date.parse(item.at))).toBe(false);
    }
  });
});

describe('changeKindLabel', () => {
  it('已登记类型给中文，未登记回落原值', () => {
    expect(changeKindLabel('CONFIG')).toBe('配置变更');
    expect(changeKindLabel('config')).toBe('配置变更');
    expect(changeKindLabel('ROLLBACK')).toBe('ROLLBACK');
  });
});
