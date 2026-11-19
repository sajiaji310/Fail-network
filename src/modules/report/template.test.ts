import { describe, expect, it } from 'vitest';
import { buildReportMarkdown, type ReportInput } from './template';

/** AC-09：报告必须含 MTTR、影响面、根因、改进项四段，且缺数据时也要把话说清楚 */

const generatedAt = new Date('2026-11-19T15:00:00+08:00');

function baseInput(overrides: Partial<ReportInput> = {}): ReportInput {
  const input: ReportInput = {
    incident: {
      code: 'INC-20261119-001',
      title: 'CORE-SW-01 板卡故障（波及 3 台设备）',
      severity: 'P0',
      status: 'RESOLVED',
      startedAt: new Date('2026-11-19T14:00:00+08:00'),
      resolvedAt: new Date('2026-11-19T14:42:00+08:00'),
      lastSeen: new Date('2026-11-19T14:40:00+08:00'),
      mttrSeconds: 42 * 60,
      summary: 'CORE-SW-01 板卡硬件故障',
      impactScope: '影响 3 台设备，其中 2 台为接入层',
      reopenedCount: 0,
      closureNote: '更换板卡后恢复',
    },
    devices: [
      { name: 'CORE-SW-01', layer: 1, alertCount: 4, suppressedCount: 0, maxSeverity: 'P0' },
      { name: 'ACC-SW-01', layer: 3, alertCount: 6, suppressedCount: 6, maxSeverity: 'P2' },
      { name: 'ACC|SW-02', layer: 3, alertCount: 2, suppressedCount: 0, maxSeverity: 'P1' },
    ],
    alerts: {
      total: 12,
      suppressed: 6,
      types: [
        { type: 'LINECARD_FAILURE', count: 4 },
        { type: 'DEVICE_UNREACHABLE', count: 8 },
      ],
    },
    hypotheses: [
      {
        rank: 1,
        cause: 'CORE-SW-01 板卡硬件故障',
        category: 'HARDWARE',
        confidence: 0.86,
        source: 'RULE_FALLBACK',
        verdict: 'ACCEPTED',
        evidence: [{ type: 'ALERT', ref: 'alert-1', desc: '板卡 FAILED' }],
        verifySteps: ['查看板卡状态'],
        actions: [
          { action: '更换故障板卡', risk: 'MEDIUM', requiresApproval: true },
          { action: '补充板卡健康巡检', risk: 'LOW', requiresApproval: false },
        ],
      },
      {
        rank: 2,
        cause: '上游链路抖动',
        category: 'LINK',
        confidence: 0.31,
        source: 'LLM',
        verdict: 'REJECTED',
        evidence: [],
        verifySteps: [],
        actions: [{ action: '检查光功率', risk: 'LOW', requiresApproval: false }],
      },
    ],
    changes: [
      {
        deviceName: 'CORE-SW-01',
        kind: 'CONFIG',
        content: '修改端口聚合',
        changedAt: new Date('2026-11-19T13:50:00+08:00'),
      },
    ],
    generatedAt,
    ...overrides,
  };
  return input;
}

describe('AC-09 报告四段', () => {
  it('固定四段齐全，顺序固定', () => {
    const md = buildReportMarkdown(baseInput());
    const headings = md.split('\n').filter((line) => line.startsWith('## '));
    expect(headings).toEqual(['## 1. MTTR', '## 2. 影响面', '## 3. 根因', '## 4. 改进项']);
  });

  it('MTTR 段给出可核对的分钟数与秒数', () => {
    const md = buildReportMarkdown(baseInput());
    expect(md).toContain('MTTR：42 分钟');
    expect(md).toContain('2520 秒');
    expect(md).toContain('2026-11-19 14:00:00');
  });

  it('未结案时 MTTR 写明"待结案后确定"，不伪造数字', () => {
    const input = baseInput();
    const md = buildReportMarkdown({
      ...input,
      incident: { ...input.incident, status: 'OPEN', resolvedAt: null, mttrSeconds: null },
    });
    expect(md).toContain('MTTR：待结案后确定');
    expect(md).toContain('尚未结案');
  });

  it('影响面按层级统计，表格里的竖线被转义（不破坏 Markdown 表格）', () => {
    const md = buildReportMarkdown(baseInput());
    expect(md).toContain('受影响设备：3 台（核心 1 / 接入 2）');
    expect(md).toContain('其中 6 条被父告警抑制');
    expect(md).toContain('ACC\\|SW-02');
  });

  it('根因采用人工采纳的假设，并标注来源与置信度', () => {
    const md = buildReportMarkdown(baseInput());
    expect(md).toContain('结论（人工采纳）：**CORE-SW-01 板卡硬件故障**');
    expect(md).toContain('86%');
    expect(md).toContain('规则引擎');
    expect(md).toContain('已人工否决');
  });

  it('没有采纳时降级为"系统首选（未人工确认）"——不冒充人工结论', () => {
    const input = baseInput();
    const md = buildReportMarkdown({
      ...input,
      hypotheses: input.hypotheses.map((h) => ({ ...h, verdict: null })),
    });
    expect(md).toContain('系统首选（未人工确认）');
  });

  it('没有任何假设时，根因段明确写"未研判或证据不足"', () => {
    const md = buildReportMarkdown(baseInput({ hypotheses: [] }));
    expect(md).toContain('未研判或证据不足');
    expect(md).toContain('## 3. 根因');
  });

  it('改进项优先取处置建议，不足 3 条用基线补齐', () => {
    const md = buildReportMarkdown(baseInput());
    const section = md.split('## 4. 改进项')[1] ?? '';
    const items = section.split('\n').filter((line) => /^\d+\. /.test(line));
    expect(items).toHaveLength(3);
    expect(items[0]).toContain('更换故障板卡');
    expect(items[0]).toContain('需审批后执行');
    expect(items[1]).toContain('补充板卡健康巡检');
    expect(items[2]).toContain('监控基线');
  });

  it('没有处置建议时仍给出 3 条可执行基线动作', () => {
    const md = buildReportMarkdown(
      baseInput({ hypotheses: [{ ...baseInput().hypotheses[0]!, actions: [] }] }),
    );
    const section = md.split('## 4. 改进项')[1] ?? '';
    expect(section.split('\n').filter((line) => /^\d+\. /.test(line))).toHaveLength(3);
  });

  it('重开过的事件在 MTTR 段标注重开次数', () => {
    const input = baseInput();
    const md = buildReportMarkdown({
      ...input,
      incident: { ...input.incident, reopenedCount: 2 },
    });
    expect(md).toContain('重开次数：2 次');
  });
});
