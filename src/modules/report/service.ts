import { db } from '@/lib/db';
import type { HypothesisView } from '@/modules/incidents/hypothesis-view';
import { getIncidentDetail } from '@/modules/incidents/detail';
import { buildReportMarkdown, type ReportAlertSummary, type ReportHypothesis } from './template';

/**
 * 报告生成（AC-09）。
 *
 * 数据一律从 getIncidentDetail 取，不另写一套查询：报告里出现的设备数、告警数、
 * 抑制数必须和页面上一模一样，两套查询早晚会说两个数。
 *
 * 每次生成都新增一条 Report 记录（保留历史），不做覆盖：报告是发给别人看过的
 * 文本，事后被改写会说不清哪版才是当时的结论。
 */

export type GenerateReportOptions = {
  now?: Date;
  /** false 时只返回文本不落库（导出/预览用） */
  save?: boolean;
  note?: string | null;
};

export type GeneratedReport = {
  incidentId: string;
  code: string;
  markdown: string;
  reportId: string | null;
  charCount: number;
  generatedAt: string;
};

export type StoredReport = {
  id: string;
  markdown: string;
  createdAt: string;
};

function toReportHypothesis(row: HypothesisView): ReportHypothesis {
  return {
    rank: row.rank,
    cause: row.cause,
    category: row.category,
    confidence: row.confidence,
    source: row.source,
    verdict: row.verdict,
    evidence: row.evidence,
    verifySteps: row.verifySteps,
    actions: row.actions,
  };
}

export async function generateReport(
  idOrCode: string,
  options: GenerateReportOptions = {},
): Promise<GeneratedReport | null> {
  const detail = await getIncidentDetail(idOrCode);
  if (!detail) return null;

  const now = options.now ?? new Date();

  const typeCount = new Map<string, number>();
  for (const alert of detail.alerts) {
    typeCount.set(alert.type, (typeCount.get(alert.type) ?? 0) + 1);
  }
  const alerts: ReportAlertSummary = {
    total: detail.alerts.length,
    suppressed: detail.stats.suppressedCount,
    types: [...typeCount.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([type, count]) => ({ type, count })),
  };

  const markdown = buildReportMarkdown({
    incident: {
      code: detail.code,
      title: detail.title,
      severity: detail.severity,
      status: detail.status,
      startedAt: new Date(detail.startedAt),
      resolvedAt: detail.resolvedAt ? new Date(detail.resolvedAt) : null,
      lastSeen: new Date(detail.lastSeen),
      mttrSeconds: detail.mttrSeconds,
      summary: detail.summary,
      impactScope: detail.impactScope,
      reopenedCount: detail.reopenedCount,
      closureNote: detail.closure?.note ?? options.note ?? null,
    },
    devices: detail.devices.map((d) => ({
      name: d.name,
      layer: d.layer,
      alertCount: d.alertCount,
      suppressedCount: d.suppressedCount,
      maxSeverity: d.maxSeverity,
    })),
    alerts,
    hypotheses: detail.hypotheses.map(toReportHypothesis),
    changes: detail.changes.map((c) => ({
      deviceName: c.deviceName,
      kind: c.kind,
      content: c.content,
      changedAt: new Date(c.changedAt),
    })),
    generatedAt: now,
  });

  let reportId: string | null = null;
  if (options.save !== false) {
    const created = await db.report.create({
      data: { incidentId: detail.id, markdown },
      select: { id: true },
    });
    reportId = created.id;
  }

  return {
    incidentId: detail.id,
    code: detail.code,
    markdown,
    reportId,
    charCount: markdown.length,
    generatedAt: now.toISOString(),
  };
}

/** 最近一次落库的报告（详情页直接展示，避免每次进页面都重新生成） */
export async function getLatestReport(idOrCode: string): Promise<StoredReport | null> {
  const incident = await db.incident.findFirst({
    where: { OR: [{ id: idOrCode }, { code: idOrCode }] },
    select: {
      reports: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: { id: true, markdown: true, createdAt: true },
      },
    },
  });
  const row = incident?.reports[0];
  if (!row) return null;
  return { id: row.id, markdown: row.markdown, createdAt: row.createdAt.toISOString() };
}
