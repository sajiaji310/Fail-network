import Link from 'next/link';
import type { CaseVerification, Severity } from '@prisma/client';
import { ArrowUpRight, BadgeCheck, BookOpen, Search, ShieldQuestion } from 'lucide-react';
import { SeverityPill } from '@/components/ui/badges';
import { buttonClass } from '@/components/ui/button';
import { CaseVerifyButton } from '@/components/domain/case-verify-button';
import { absTime, duration, relTime } from '@/lib/utils/time';
import { getCaseStats, getCaseTagStats, listCases } from '@/modules/case/service';
import { cn } from '@/lib/utils/cn';

export const dynamic = 'force-dynamic';

const VERIFICATION_FILTERS = [
  { key: '', label: '全部' },
  { key: 'VERIFIED', label: '已验证' },
  { key: 'UNVERIFIED', label: '待确认' },
  { key: 'REJECTED', label: '已驳回' },
] as const;

const VERIFICATION_BADGE: Record<
  CaseVerification,
  { label: string; className: string; icon: typeof BadgeCheck }
> = {
  VERIFIED: { label: '已验证', className: 'bg-ok-soft text-ok', icon: BadgeCheck },
  UNVERIFIED: { label: '待确认', className: 'bg-warn-soft text-warn', icon: ShieldQuestion },
  REJECTED: {
    label: '已驳回',
    className: 'bg-surface-muted text-text-tertiary',
    icon: ShieldQuestion,
  },
};

/**
 * 案例库（文档 11.1 `/cases`）。
 *
 * MVP-0 只做关键词检索（决策 8：语义检索后置）。页面刻意把「现象 / 根因 / 处置」
 * 三段原文都摊开：案例的用途是让人快速判断"这条跟我现在遇到的是不是一回事"，
 * 折叠起来省的那点高度，不如一次扫读来得快。
 *
 * 可信度（评审 P0-3）在卡片上直接标出来：只有「已验证」的案例会进入下次研判的
 * 召回上下文，「待确认」的留在库里等人工看过再晋升 —— 页面必须让人一眼看出
 * 哪条经验是老师傅确认过的、哪条只是机器的猜测。
 */
export default async function CasesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; tag?: string; v?: string }>;
}) {
  const { q: rawQ, tag, v: rawV } = await searchParams;
  const q = (rawQ ?? '').trim();
  const verification = VERIFICATION_FILTERS.some((f) => f.key === rawV && f.key !== '')
    ? (rawV as CaseVerification)
    : undefined;

  const [list, tags, stats] = await Promise.all([
    listCases({ q, tag, verification, page: 1, pageSize: 30 }),
    getCaseTagStats(),
    getCaseStats(),
  ]);

  const filtered = Boolean(q || tag || verification);
  /** null 表示"清空这个条件"，undefined 表示"保持原样" */
  const buildHref = (overrides: { q?: string | null; tag?: string | null; v?: string | null }) => {
    const nextQ = overrides.q === undefined ? q : (overrides.q ?? '');
    const nextTag = overrides.tag === undefined ? tag : (overrides.tag ?? '');
    const nextV = overrides.v === undefined ? (verification ?? '') : (overrides.v ?? '');
    const params = new URLSearchParams();
    if (nextQ) params.set('q', nextQ);
    if (nextTag) params.set('tag', nextTag);
    if (nextV) params.set('v', nextV);
    const query = params.toString();
    return query ? `/cases?${query}` : '/cases';
  };

  return (
    <div className="mx-auto max-w-[1180px]">
      <header className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[22px] leading-7 font-semibold tracking-tight">案例库</h1>
          <p className="mt-0.5 text-[12px] text-text-secondary">
            结案时自动沉淀的故障案例 · 共 {stats.total} 条，近 7 天新增 {stats.last7d} 条 · 已验证{' '}
            {stats.verified} / 待确认 {stats.unverified}
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
        {verification ? <input type="hidden" name="v" value={verification} /> : null}
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

      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        <span className="text-[10.5px] text-text-tertiary">可信度</span>
        {VERIFICATION_FILTERS.map((item) => {
          const active = (verification ?? '') === item.key;
          const count =
            item.key === 'VERIFIED'
              ? stats.verified
              : item.key === 'UNVERIFIED'
                ? stats.unverified
                : item.key === 'REJECTED'
                  ? stats.rejected
                  : stats.total;
          return (
            <Link
              key={item.key || 'all'}
              href={buildHref({ v: item.key || null })}
              className={cn(
                'inline-flex items-center gap-1 rounded-[4px] px-1.5 py-0.5 text-[10.5px] transition-colors',
                active
                  ? 'bg-primary-soft text-primary'
                  : 'bg-surface-muted text-text-secondary hover:text-text',
              )}
            >
              {item.label}
              <span className="font-mono text-[9px] text-text-tertiary">{count}</span>
            </Link>
          );
        })}
        <span className="ml-1 text-[10.5px] text-text-tertiary">
          只有「已验证」参与下次研判的案例召回
        </span>
      </div>

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
          {list.items.map((item) => {
            const badge = VERIFICATION_BADGE[item.verification];
            const BadgeIcon = badge.icon;
            return (
              <li
                key={item.id}
                className="flex flex-col rounded-xl border border-border bg-surface px-4 py-3.5 shadow-card transition-all duration-200 hover:-translate-y-px hover:border-border-strong/90 hover:shadow-raised"
              >
                <div className="flex flex-wrap items-center gap-1.5">
                  <SeverityPill severity={item.severity as Severity} compact />
                  <span
                    className={cn(
                      'inline-flex items-center gap-0.5 rounded-[3px] px-1 py-px text-[10px]',
                      badge.className,
                    )}
                    title={
                      item.verifyNote ??
                      (item.verification === 'VERIFIED'
                        ? '已人工确认，参与研判召回'
                        : '未确认的机器结论，不参与召回')
                    }
                  >
                    <BadgeIcon size={9} strokeWidth={2.2} />
                    {badge.label}
                  </span>
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

                <div className="mt-2 flex items-center justify-between gap-2 border-t border-border pt-2">
                  <span className="text-[10px] text-text-tertiary">
                    {item.verification === 'VERIFIED'
                      ? item.verifiedAt
                        ? `确认于 ${relTime(item.verifiedAt)}`
                        : '已验证，参与召回'
                      : item.verification === 'REJECTED'
                        ? '已驳回，不再参与召回'
                        : '人工确认后才会参与召回'}
                  </span>
                  <CaseVerifyButton caseId={item.id} verification={item.verification} />
                </div>
              </li>
            );
          })}
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
