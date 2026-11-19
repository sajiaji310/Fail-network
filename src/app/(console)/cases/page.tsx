import Link from 'next/link';
import type { Severity } from '@prisma/client';
import { ArrowUpRight, BookOpen, Search } from 'lucide-react';
import { SeverityPill } from '@/components/ui/badges';
import { buttonClass } from '@/components/ui/button';
import { absTime, duration, relTime } from '@/lib/utils/time';
import { getCaseStats, getCaseTagStats, listCases } from '@/modules/case/service';
import { cn } from '@/lib/utils/cn';

export const dynamic = 'force-dynamic';

/**
 * 案例库（文档 11.1 `/cases`）。
 *
 * MVP-0 只做关键词检索（决策 8：语义检索后置）。页面刻意把「现象 / 根因 / 处置」
 * 三段原文都摊开：案例的用途是让人快速判断"这条跟我现在遇到的是不是一回事"，
 * 折叠起来省的那点高度，不如一次扫读来得快。
 */
export default async function CasesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; tag?: string }>;
}) {
  const { q: rawQ, tag } = await searchParams;
  const q = (rawQ ?? '').trim();

  const [list, tags, stats] = await Promise.all([
    listCases({ q, tag, page: 1, pageSize: 30 }),
    getCaseTagStats(),
    getCaseStats(),
  ]);

  const filtered = Boolean(q || tag);
  /** null 表示"清空这个条件"，undefined 表示"保持原样" */
  const buildHref = (overrides: { q?: string | null; tag?: string | null }) => {
    const nextQ = overrides.q === undefined ? q : (overrides.q ?? '');
    const nextTag = overrides.tag === undefined ? tag : (overrides.tag ?? '');
    const params = new URLSearchParams();
    if (nextQ) params.set('q', nextQ);
    if (nextTag) params.set('tag', nextTag);
    const query = params.toString();
    return query ? `/cases?${query}` : '/cases';
  };

  return (
    <div className="mx-auto max-w-[1180px]">
      <header className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[22px] leading-7 font-semibold tracking-tight">案例库</h1>
          <p className="mt-0.5 text-[12px] text-text-secondary">
            结案时自动沉淀的故障案例 · 共 {stats.total} 条，近 7 天新增 {stats.last7d} 条
          </p>
        </div>
      </header>

      <form action="/cases" className="mb-3 flex items-center gap-2">
        <div className="relative flex-1">
          <Search
            size={14}
            strokeWidth={1.8}
            className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-text-tertiary"
          />
          <input
            type="search"
            name="q"
            defaultValue={q}
            placeholder="搜索现象、根因、处置内容或标签，多个词用空格分隔（按 AND 匹配）"
            className="h-9 w-full rounded-[8px] border border-border-strong bg-surface pr-3 pl-8 text-[12.5px] text-text shadow-pill transition-shadow outline-none placeholder:text-text-tertiary focus:border-primary focus:shadow-[0_0_0_3px_var(--color-primary-ring)]"
          />
        </div>
        {tag ? <input type="hidden" name="tag" value={tag} /> : null}
        <button
          type="submit"
          className="inline-flex h-9 items-center rounded-[8px] bg-linear-to-b from-primary to-primary-hover px-3.5 text-[12.5px] font-medium text-text-inverse shadow-[inset_0_1px_0_rgba(255,255,255,0.16),0_1px_2px_rgba(15,23,42,0.18)] transition-all duration-150 hover:brightness-[1.06] active:translate-y-px"
        >
          检索
        </button>
        {filtered ? (
          <Link
            href="/cases"
            className="inline-flex h-9 items-center rounded-[6px] border border-border-strong bg-surface px-3 text-[12.5px] text-text-secondary hover:bg-surface-muted hover:text-text"
          >
            清除筛选
          </Link>
        ) : null}
      </form>

      {tags.length > 0 ? (
        <div className="mb-4 flex flex-wrap items-center gap-1.5">
          <span className="text-[10.5px] text-text-tertiary">常用标签</span>
          {tags.map((item) => {
            const active = item.tag === tag;
            return (
              <Link
                key={item.tag}
                href={active ? buildHref({ tag: null }) : buildHref({ tag: item.tag })}
                className={cn(
                  'inline-flex items-center gap-1 rounded-[4px] px-1.5 py-0.5 text-[10.5px] transition-colors',
                  active
                    ? 'bg-primary-soft text-primary'
                    : 'bg-surface-muted text-text-secondary hover:text-text',
                )}
              >
                {item.tag}
                <span className="font-mono text-[9px] text-text-tertiary">{item.count}</span>
              </Link>
            );
          })}
        </div>
      ) : null}

      {list.items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border-strong bg-surface px-6 py-14 text-center">
          <BookOpen size={22} strokeWidth={1.5} className="mx-auto text-text-tertiary" />
          <p className="mt-2 text-[14px] font-medium text-text">
            {filtered ? '没有匹配的案例' : '案例库还是空的'}
          </p>
          <p className="mx-auto mt-1.5 max-w-[460px] text-[12px] leading-5 text-text-tertiary">
            {filtered
              ? '检索按「所有词都要命中」计算，词太多会收不到结果。试试只留设备名或现象里的一个关键词。'
              : '案例在事件结案时自动沉淀：结案会写入 MTTR、采纳的根因与处置动作，并生成复盘报告。先去事件页把一个事件结案。'}
          </p>
          <div className="mt-4 flex items-center justify-center gap-2">
            {filtered ? (
              <Link href="/cases" className={buttonClass({ variant: 'secondary', size: 'sm' })}>
                清除筛选
              </Link>
            ) : (
              <Link href="/incidents" className={buttonClass({ variant: 'primary', size: 'sm' })}>
                去事件列表结案
              </Link>
            )}
          </div>
        </div>
      ) : (
        <ul className="grid gap-3 lg:grid-cols-2">
          {list.items.map((item) => (
            <li
              key={item.id}
              className="flex flex-col rounded-xl border border-border bg-surface px-4 py-3.5 shadow-card transition-all duration-200 hover:-translate-y-px hover:border-border-strong/90 hover:shadow-raised"
            >
              <div className="flex flex-wrap items-center gap-1.5">
                <SeverityPill severity={item.severity as Severity} compact />
                <span className="font-mono text-[10px] text-text-tertiary">
                  {item.incidentCode}
                </span>
                {item.mttrSeconds !== null ? (
                  <span className="font-mono text-[10px] text-text-tertiary">
                    MTTR {duration(item.mttrSeconds)}
                  </span>
                ) : null}
                <time
                  dateTime={item.createdAt}
                  title={absTime(item.createdAt)}
                  className="ml-auto font-mono text-[10px] text-text-tertiary"
                  suppressHydrationWarning
                >
                  {relTime(item.createdAt)}
                </time>
              </div>

              <h2 className="mt-1.5 text-[13.5px] font-medium leading-5">{item.title}</h2>

              <dl className="mt-2 space-y-1.5">
                <Row label="现象" value={item.symptom} />
                <Row label="根因" value={item.rootCause} accent />
                <Row label="处置" value={item.resolution} />
              </dl>

              <div className="mt-2.5 flex flex-wrap items-center gap-1">
                {item.tags.map((tagName) => (
                  <span
                    key={tagName}
                    className="rounded-[3px] bg-surface-muted px-1 py-px text-[10px] text-text-secondary"
                  >
                    {tagName}
                  </span>
                ))}
                <Link
                  href={`/incidents/${item.incidentId}`}
                  className="ml-auto inline-flex items-center gap-0.5 text-[10.5px] text-primary hover:underline"
                >
                  查看事件
                  <ArrowUpRight size={10} strokeWidth={2} />
                </Link>
              </div>
            </li>
          ))}
        </ul>
      )}

      {list.total > list.items.length ? (
        <p className="mt-4 text-center text-[11px] text-text-tertiary">
          共 {list.total} 条，当前展示前 {list.items.length} 条。用关键词或标签收窄范围。
        </p>
      ) : null}
    </div>
  );
}

function Row({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="flex gap-2 text-[11px] leading-[1.55]">
      <dt className="w-7 shrink-0 text-text-tertiary">{label}</dt>
      <dd className={accent ? 'text-text' : 'text-text-secondary'}>{value}</dd>
    </div>
  );
}
