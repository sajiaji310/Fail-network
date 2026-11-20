'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, LogOut, UserCheck, UserPlus } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { absTime, relTime } from '@/lib/utils/time';
import type { IncidentStatus } from '@prisma/client';
import type { ResponseInfo } from '@/modules/incidents/sla';

/**
 * 接手 / 转派 / 释放（评审 5.3）。
 *
 * 未接手时这块是全页最显眼的东西：评审的原话是"多人协作时容易出现
 * 大家都看到了，但没有人负责"，所以它不能是一个藏在菜单里的次要按钮。
 *
 * 姓名记在 localStorage 只是为了少打一次字，不作为身份使用 ——
 * 真正的操作者由服务端从请求身份解析（审计里的 actor 才是权威）。
 */

const ACTOR_KEY = 'netscope.actor';
const TEAM_KEY = 'netscope.team';

const ACTIVE: readonly IncidentStatus[] = ['OPEN', 'ANALYZING', 'LOCATED', 'MITIGATED'];

function formatRemaining(seconds: number): string {
  const abs = Math.abs(seconds);
  const m = Math.floor(abs / 60);
  const s = abs % 60;
  const text = m > 0 ? `${m} 分${s > 0 ? ` ${s} 秒` : ''}` : `${s} 秒`;
  return seconds >= 0 ? `剩余 ${text}` : `已超时 ${text}`;
}

export function ClaimPanel({
  incidentId,
  status,
  assignee,
  team,
  claimedAt,
  response,
}: {
  incidentId: string;
  status: IncidentStatus;
  assignee: string | null;
  team: string | null;
  claimedAt: string | null;
  response: ResponseInfo;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmTakeover, setConfirmTakeover] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [teamInput, setTeamInput] = useState('');
  /** 每秒刷新剩余时间：服务端算的是渲染那一刻，页面停留久了会过时 */
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setName(window.localStorage.getItem(ACTOR_KEY) ?? '');
    setTeamInput(window.localStorage.getItem(TEAM_KEY) ?? '网络组');
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const active = ACTIVE.includes(status);
  const dueAtMs = new Date(response.dueAt).getTime();
  const remaining = Math.round((dueAtMs - now) / 1000);

  async function submit(options: { assignee?: string; force?: boolean } = {}) {
    setPending(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/incidents/${encodeURIComponent(incidentId)}/claim`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          assignee: options.assignee ?? name.trim(),
          ...(teamInput.trim() ? { team: teamInput.trim() } : {}),
          ...(options.force ? { force: true } : {}),
        }),
      });
      const body = (await res.json().catch(() => null)) as {
        error?: { code?: string; message?: string; details?: { assignee?: string } };
      } | null;

      if (!res.ok) {
        if (body?.error?.code === 'ALREADY_CLAIMED') {
          setConfirmTakeover(body.error.details?.assignee ?? '他人');
          throw new Error(body.error.message ?? '事件已被他人接手');
        }
        throw new Error(body?.error?.message ?? `接手失败（HTTP ${res.status}）`);
      }

      window.localStorage.setItem(ACTOR_KEY, name.trim());
      window.localStorage.setItem(TEAM_KEY, teamInput.trim());
      setOpen(false);
      setConfirmTakeover(null);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : '接手失败');
    } finally {
      setPending(false);
    }
  }

  async function release() {
    setPending(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/incidents/${encodeURIComponent(incidentId)}/claim`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        throw new Error(body?.error?.message ?? `释放失败（HTTP ${res.status}）`);
      }
      setOpen(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : '释放失败');
    } finally {
      setPending(false);
    }
  }

  if (!active) {
    return (
      <section className="rounded-[10px] bg-surface-muted/60 px-3 py-2.5">
        <div className="flex items-center gap-1.5 text-[11px] text-text-secondary">
          <UserCheck size={11} strokeWidth={2} className="text-text-tertiary" />
          {assignee ? `${assignee} 处理，事件已结束` : '事件已结束'}
          {claimedAt ? (
            <span className="ml-auto font-mono text-[10px] text-text-tertiary">
              响应 {Math.round((response.claimSeconds ?? 0) / 60)} 分钟
            </span>
          ) : null}
        </div>
      </section>
    );
  }

  const breached = response.state === 'BREACHED';
  const dueSoon = response.state === 'DUE_SOON';

  return (
    <section
      className={cn(
        'rounded-[10px] px-3 py-2.5',
        assignee
          ? 'bg-surface-muted/60'
          : breached
            ? 'bg-danger-soft ring-1 ring-inset ring-danger/25'
            : 'bg-warn-soft ring-1 ring-inset ring-warn/25',
      )}
    >
      <div className="flex items-center gap-1.5">
        <h2 className="text-[13px] font-medium">
          {assignee ? '当前处理人' : breached ? '无人接手 · 已超响应时限' : '待接手'}
        </h2>
        {assignee ? (
          <span className="ml-auto font-mono text-[10px] text-text-tertiary">
            {response.claimSeconds !== null
              ? `响应 ${Math.max(1, Math.round(response.claimSeconds / 60))} 分钟 / 时限 ${response.slaMinutes} 分钟`
              : `时限 ${response.slaMinutes} 分钟`}
          </span>
        ) : null}
      </div>

      {assignee ? (
        <>
          <p className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[11.5px]">
            <span className="font-medium text-text">{assignee}</span>
            {team ? <span className="text-[10.5px] text-text-secondary">{team}</span> : null}
            {claimedAt ? (
              <span className="text-[10px] text-text-tertiary" suppressHydrationWarning>
                接手于 {relTime(claimedAt)}
                {response.claimSeconds !== null
                  ? `（响应 ${Math.max(1, Math.round(response.claimSeconds / 60))} 分钟）`
                  : ''}
              </span>
            ) : null}
          </p>
          <div className="mt-1.5 flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setOpen(true);
                setConfirmTakeover(null);
              }}
              className="text-[10px] text-text-tertiary hover:text-primary"
            >
              转派给他人
            </button>
            <button
              type="button"
              onClick={release}
              disabled={pending}
              className="inline-flex items-center gap-0.5 text-[10px] text-text-tertiary hover:text-danger disabled:opacity-50"
            >
              <LogOut size={9} strokeWidth={2} />
              释放回队列
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="mt-1 text-[10.5px] leading-4 text-text-secondary">
            还没有人认领。接手后你会成为这个事件的责任人，其他人看到的是"已由你处理"。
          </p>
          <p
            className={cn(
              'mt-1 font-mono text-[10px]',
              breached ? 'text-danger' : dueSoon ? 'text-warn' : 'text-text-tertiary',
            )}
            suppressHydrationWarning
          >
            {formatRemaining(remaining)} · 响应时限 {response.slaMinutes} 分钟
          </p>
          <button
            type="button"
            onClick={() => setOpen(true)}
            disabled={pending}
            className="mt-2 inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-[6px] bg-primary text-[12px] font-medium text-text-inverse hover:bg-primary-hover disabled:opacity-60"
          >
            {pending ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <UserPlus size={12} strokeWidth={2} />
            )}
            接手事件
          </button>
        </>
      )}

      {open ? (
        <div className="mt-2 rounded-[8px] border border-border bg-surface px-2.5 py-2">
          <label className="block text-[10px] text-text-secondary">
            你的名字
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={40}
              placeholder="例：陈昊"
              className="mt-1 h-7 w-full rounded-[5px] border border-border-strong bg-surface px-2 text-[11.5px] text-text outline-none focus:border-primary"
            />
          </label>
          <label className="mt-1.5 block text-[10px] text-text-secondary">
            团队
            <input
              value={teamInput}
              onChange={(event) => setTeamInput(event.target.value)}
              maxLength={40}
              placeholder="例：网络组"
              className="mt-1 h-7 w-full rounded-[5px] border border-border-strong bg-surface px-2 text-[11.5px] text-text outline-none focus:border-primary"
            />
          </label>

          {confirmTakeover ? (
            <p className="mt-2 rounded-[5px] bg-warn-soft px-2 py-1 text-[10px] leading-4 text-warn">
              该事件已由 {confirmTakeover} 接手，继续将从对方名下转派给你。
            </p>
          ) : null}

          <div className="mt-2 flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => submit({ force: confirmTakeover !== null })}
              disabled={pending || name.trim().length === 0}
              className="inline-flex h-7 items-center gap-1 rounded-[5px] bg-primary px-2.5 text-[11px] text-text-inverse hover:bg-primary-hover disabled:opacity-50"
            >
              {pending ? <Loader2 size={10} className="animate-spin" /> : null}
              {confirmTakeover ? '确认转派' : '确认接手'}
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setConfirmTakeover(null);
                setError(null);
              }}
              className="h-7 rounded-[5px] border border-border-strong bg-surface px-2.5 text-[11px] text-text-secondary hover:bg-surface-muted"
            >
              取消
            </button>
            {claimedAt ? (
              <span className="ml-auto font-mono text-[9.5px] text-text-tertiary">
                接手于 {absTime(claimedAt)}
              </span>
            ) : null}
          </div>
        </div>
      ) : null}

      {error ? (
        <p className="mt-2 rounded-[5px] bg-surface px-2 py-1 text-[10px] leading-4 text-danger">
          {error}
        </p>
      ) : null}
    </section>
  );
}
