'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowUpRight, Loader2, Play } from 'lucide-react';
import { cn } from '@/lib/utils/cn';

type ScenarioItem = {
  name: string;
  desc: string;
  alerts: number;
  changes: number;
};

type InjectResult = {
  name: string;
  title: string;
  incidentId: string | null;
  alertTotal: number;
  created: number;
  applied: boolean;
};

/**
 * 剧本注入入口（文档 11.1 `/settings` 的第三块）。
 *
 * 和 `npm run sim` 走同一个接口、同一份 fixture，所以"页面上注入"和"命令行注入"
 * 的结果一致 —— 不是另外造一条演示通道。
 *
 * `reset` 默认打开：不清场的话第二个剧本会和上一个并成一个 mega 事件（B5 沿用一个
 * 未结事件），现场会非常难解释。想看合并行为时才建议关掉。
 */
export function ScenarioInject({
  items,
  activeIncidents,
}: {
  items: ScenarioItem[];
  activeIncidents: number;
}) {
  const router = useRouter();
  const [reset, setReset] = useState(true);
  const [pending, setPending] = useState<string | null>(null);
  const [result, setResult] = useState<InjectResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function inject(item: ScenarioItem) {
    setPending(item.name);
    setError(null);
    setResult(null);
    try {
      const res = await fetch('/api/v1/ingest/simulate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scenario: item.name, reset }),
      });
      const body: unknown = await res.json();
      if (!res.ok) {
        const message =
          (body as { error?: { message?: string } })?.error?.message ?? `HTTP ${res.status}`;
        throw new Error(message);
      }
      const payload = body as {
        title: string;
        incidentId: string | null;
        alertTotal: number;
        correlation?: { created?: number };
      };
      setResult({
        name: item.name,
        title: payload.title,
        incidentId: payload.incidentId,
        alertTotal: payload.alertTotal,
        created: payload.correlation?.created ?? 0,
        applied: true,
      });
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : '注入失败');
    } finally {
      setPending(null);
    }
  }

  if (items.length === 0) {
    return (
      <p className="text-[12px] text-text-tertiary">
        没有找到剧本。检查 <code className="font-mono">scripts/fixtures/scenarios</code>{' '}
        是否随代码一起部署。
      </p>
    );
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-3 rounded-[8px] bg-surface-muted px-3 py-2 text-[12px]">
        <label className="flex cursor-pointer items-center gap-1.5 text-text-secondary">
          <input
            type="checkbox"
            checked={reset}
            onChange={(e) => setReset(e.target.checked)}
            className="size-3.5 accent-primary"
          />
          注入前清场
        </label>
        <span className="text-text-tertiary">
          {reset
            ? '先清掉上一次注入的告警与事件，保证一套剧本一个干净事件'
            : `不清场：新告警可能被 ${activeIncidents} 个未结事件沿用，多个剧本会并成同一个事件`}
        </span>
      </div>

      <ul className="divide-y divide-border">
        {items.map((item) => (
          <li key={item.name} className="flex items-start gap-3 py-2.5">
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-baseline gap-2">
                <span className="font-mono text-[12.5px] text-text">{item.name}</span>
                <span className="font-mono text-[11px] text-text-tertiary">
                  {item.alerts} 条告警
                  {item.changes > 0 ? ` · ${item.changes} 条变更` : ''}
                </span>
              </p>
              <p className="mt-0.5 text-[12px] leading-relaxed text-text-secondary">{item.desc}</p>
            </div>
            <button
              type="button"
              onClick={() => void inject(item)}
              disabled={pending !== null}
              className={cn(
                'inline-flex h-7 shrink-0 items-center gap-1 rounded-[6px] border px-2 text-[11px] transition-colors',
                'border-border-strong bg-surface text-text-secondary',
                'hover:bg-surface-muted hover:text-text',
                'disabled:cursor-not-allowed disabled:opacity-50',
              )}
            >
              {pending === item.name ? (
                <Loader2 size={11} strokeWidth={2} className="animate-spin" />
              ) : (
                <Play size={11} strokeWidth={2} />
              )}
              注入
            </button>
          </li>
        ))}
      </ul>

      {error ? (
        <p className="mt-3 rounded-[6px] bg-danger-soft px-3 py-2 text-[12px] text-danger">
          注入失败：{error}
        </p>
      ) : null}

      {result ? (
        <div className="mt-3 rounded-[6px] bg-ok-soft px-3 py-2 text-[12px]">
          <p className="text-ok">
            已注入 {result.alertTotal} 条告警，新建 {result.created} 个事件
            {result.title ? ` · ${result.title}` : ''}
          </p>
          <p className="mt-1 flex flex-wrap gap-3 text-text-secondary">
            {result.incidentId ? (
              <Link
                href={`/incidents/${result.incidentId}`}
                className="inline-flex items-center gap-0.5 text-primary hover:underline"
              >
                打开事件
                <ArrowUpRight size={11} strokeWidth={2} />
              </Link>
            ) : (
              <span className="text-danger">
                没有生成事件（告警数未达下限或时间窗不重叠），检查剧本或调低 MIN_ALERTS_PER_INCIDENT
              </span>
            )}
            <Link href="/incidents" className="text-text-secondary hover:underline">
              去事件列表
            </Link>
          </p>
        </div>
      ) : null}
    </div>
  );
}
