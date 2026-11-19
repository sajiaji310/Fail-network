'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { IncidentStatus } from '@prisma/client';
import { Check, ChevronDown, ChevronRight, Copy, Download, FileText, Loader2 } from 'lucide-react';
import { absTime, relTime } from '@/lib/utils/time';

/**
 * 复盘报告面板（AC-09）。
 *
 * 刻意用 `<pre>` 原样展示 Markdown，而不是渲染成富文本：
 * 1. 这份报告的用途是"复制进周报/群消息"，用户需要的是能整段拿走的原文；
 * 2. 渲染 Markdown 要引依赖，而项目铁律是"不新增依赖，先在 STATE.md 记请求"。
 *
 * 生成走 POST（返回 text/markdown），成功后用本地 state 立即显示，同时 refresh
 * 让 RSC 重新取库里的最新报告 —— 刷新页面后看到的是同一份内容。
 */
export function ReportPanel({
  incidentId,
  code,
  status,
  report,
}: {
  incidentId: string;
  code: string;
  status: IncidentStatus;
  report: { id: string; markdown: string; createdAt: string } | null;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [pending, setPending] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const markdown = draft ?? report?.markdown ?? null;
  const resolved = status === 'RESOLVED' || status === 'CLOSED';

  async function generate() {
    setPending(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/incidents/${encodeURIComponent(incidentId)}/report`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
      }
      setDraft(await res.text());
      setCollapsed(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : '报告生成失败');
    } finally {
      setPending(false);
    }
  }

  async function copy() {
    if (!markdown) return;
    try {
      await navigator.clipboard.writeText(markdown);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setError('浏览器拒绝了剪贴板权限，请手动选择文本复制');
    }
  }

  function download() {
    if (!markdown) return;
    const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${code}-report.md`;
    // 必须挂到文档里再点，否则部分浏览器/驱动不会把它当成用户发起的下载；
    // 撤销要等浏览器把 blob 读走之后再执行，同步撤销会把下载掐断。
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  return (
    <section className="mt-4 rounded-[10px] border border-border bg-surface">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-2.5">
        <button
          type="button"
          onClick={() => setCollapsed((value) => !value)}
          className="inline-flex items-center gap-1.5 text-[13px] font-medium"
          aria-expanded={!collapsed}
        >
          {collapsed ? (
            <ChevronRight size={14} strokeWidth={2} className="text-text-tertiary" />
          ) : (
            <ChevronDown size={14} strokeWidth={2} className="text-text-tertiary" />
          )}
          <FileText size={14} strokeWidth={2} className="text-text-tertiary" />
          复盘报告
        </button>

        {report ? (
          <span className="font-mono text-[10px] text-text-tertiary" suppressHydrationWarning>
            生成于 {relTime(report.createdAt)} · {markdown?.length ?? 0} 字符
          </span>
        ) : (
          <span className="text-[10.5px] text-text-tertiary">
            {resolved ? '结案时未生成，可手动补生成' : '尚未结案，可先生成草稿'}
          </span>
        )}

        <div className="ml-auto flex items-center gap-1.5">
          {markdown ? (
            <>
              <button
                type="button"
                onClick={copy}
                className="inline-flex h-7 items-center gap-1 rounded-[6px] border border-border-strong bg-surface px-2 text-[11px] text-text-secondary hover:bg-surface-muted hover:text-text"
              >
                {copied ? (
                  <Check size={11} strokeWidth={2} className="text-ok" />
                ) : (
                  <Copy size={11} strokeWidth={2} />
                )}
                {copied ? '已复制' : '复制'}
              </button>
              <button
                type="button"
                onClick={download}
                className="inline-flex h-7 items-center gap-1 rounded-[6px] border border-border-strong bg-surface px-2 text-[11px] text-text-secondary hover:bg-surface-muted hover:text-text"
              >
                <Download size={11} strokeWidth={2} />
                下载 .md
              </button>
            </>
          ) : null}
          <button
            type="button"
            onClick={generate}
            disabled={pending}
            className="inline-flex h-7 items-center gap-1 rounded-[6px] bg-primary px-2 text-[11px] font-medium text-text-inverse hover:bg-primary-hover disabled:opacity-60"
          >
            {pending ? <Loader2 size={11} className="animate-spin" /> : null}
            {pending ? '生成中…' : markdown ? '重新生成' : '生成报告'}
          </button>
        </div>
      </header>

      {error ? (
        <p className="border-b border-border bg-[#FEF3F2] px-4 py-2 text-[11px] text-danger">
          {error}
        </p>
      ) : null}

      {!collapsed ? (
        markdown ? (
          <div className="max-h-[520px] overflow-auto">
            <pre className="whitespace-pre-wrap break-words px-4 py-3 font-mono text-[11px] leading-[1.65] text-text-secondary">
              {markdown}
            </pre>
          </div>
        ) : (
          <div className="px-4 py-6 text-center">
            <p className="text-[12px] text-text-secondary">
              还没有报告。报告固定四段：MTTR、影响面、根因、改进项。
            </p>
            <p className="mx-auto mt-1 max-w-[460px] text-[11px] leading-5 text-text-tertiary">
              {resolved
                ? '结案时会自动生成一份；如果当时生成失败，可以在这里补生成。'
                : '现在生成的是草稿：MTTR 会标注「待结案后确定」，结案时会再生成一份最终版。'}
            </p>
          </div>
        )
      ) : null}

      {report && !collapsed ? (
        <footer className="border-t border-border px-4 py-1.5 text-[10px] text-text-tertiary">
          报告快照 ID <span className="font-mono">{report.id.slice(-8)}</span> · 生成时间{' '}
          {absTime(report.createdAt)} · 每次生成都会新增快照，历史不覆盖
        </footer>
      ) : null}
    </section>
  );
}
