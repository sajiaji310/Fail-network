'use client';

import { useState } from 'react';
import { buttonClass } from '@/components/ui/button';

type Report = {
  dryRun: boolean;
  deleted: { metrics: number; audit: number; batches: number; incidents: number };
};

/**
 * 保留策略的预览按钮。
 *
 * 只给 dry-run：真删必须走 `npm run db:retention -- --run` 或带 `{"dryRun":false}`
 * 的显式调用 —— 页面上的一个按钮不该有"删掉半年审计"的能力。
 */
export function RetentionPanel({
  policy,
}: {
  policy: { metricDays: number; auditDays: number; batchDays: number; closedIncidentDays: number };
}) {
  const [report, setReport] = useState<Report | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function preview() {
    setPending(true);
    setError(null);
    try {
      const res = await fetch('/api/v1/admin/retention', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dryRun: true }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { message?: string } };
        setError(body?.error?.message ?? `预览失败（HTTP ${res.status}）`);
        return;
      }
      setReport((await res.json()) as Report);
    } catch {
      setError('网络异常，请重试');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={preview}
        disabled={pending}
        className={buttonClass({ variant: 'secondary', size: 'sm' })}
      >
        {pending ? '统计中…' : '预览可清理条数'}
      </button>
      {report ? (
        <span className="font-mono text-[10.5px] text-text-secondary">
          指标 {report.deleted.metrics} · 审计 {report.deleted.audit} · 批次{' '}
          {report.deleted.batches} · 事件 {report.deleted.incidents}
        </span>
      ) : null}
      {error ? <span className="text-[10.5px] text-danger">{error}</span> : null}
      <span className="text-[10px] text-text-tertiary">
        dry-run 不删数据；真删用 <code className="font-mono">npm run db:retention -- --run</code>
        {policy.closedIncidentDays === 0 ? '（事件默认不清理）' : ''}
      </span>
    </div>
  );
}
