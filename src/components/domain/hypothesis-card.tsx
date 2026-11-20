import { AlertTriangle, Check, CheckCircle2, GitBranch, ListChecks, Wrench, X } from 'lucide-react';
import type { HypothesisView } from '@/modules/incidents/hypothesis-view';
import { VerifyChecklist } from './verify-checklist';

/**
 * 单条根因假设卡片。
 *
 * 展示顺序刻意按"人怎么用"排：结论 → 为什么这么判（证据）→ 怎么验证 → 怎么处置。
 * 证据一定要显示 ref 的短码：值班的人要能拿着 ID 去告警流里核对，只写描述等于不可审计。
 */

const CATEGORY_LABEL: Record<string, string> = {
  HARDWARE: '硬件',
  CONFIG: '配置',
  LINK: '链路',
  CAPACITY: '容量',
  UPSTREAM: '上游',
  OTHER: '其它',
};

const EVIDENCE_LABEL: Record<string, string> = {
  ALERT: '告警',
  CHANGE: '变更',
  TOPOLOGY: '拓扑',
  CASE: '案例',
};

const RISK_STYLE: Record<string, string> = {
  LOW: 'text-ok',
  MEDIUM: 'text-warn',
  HIGH: 'text-danger',
};

const RISK_LABEL: Record<string, string> = { LOW: '低风险', MEDIUM: '中风险', HIGH: '高风险' };

function shortRef(ref: string): string {
  return ref.length > 8 ? ref.slice(-8) : ref;
}

export function HypothesisCard({
  hypothesis,
  incidentId,
  verdictPending = false,
  onVerdict,
}: {
  hypothesis: HypothesisView;
  /** 传入后可勾选验证步骤；不传则只读展示（报告、案例等只读场景） */
  incidentId?: string;
  verdictPending?: boolean;
  onVerdict?: (verdict: 'ACCEPTED' | 'REJECTED' | null) => void;
}) {
  const percent = Math.round(hypothesis.confidence * 100);
  const isRule = hypothesis.source === 'RULE_FALLBACK';
  const accepted = hypothesis.verdict === 'ACCEPTED';
  const rejected = hypothesis.verdict === 'REJECTED';

  /**
   * "为什么排在这里"（评审 5.2）：排序分不看数字看信号组成。
   * 只列真的出现在证据里的那几类，不写"综合评估"这种说了等于没说的话。
   */
  const signalCount = (type: string) =>
    hypothesis.evidence.filter((item) => item.type === type).length;
  const signals = [
    ['CHANGE', '变更关联'],
    ['TOPOLOGY', '拓扑证据'],
    ['CASE', '历史案例'],
  ]
    .map(([type, label]) => ({ label: label!, count: signalCount(type!) }))
    .filter((s) => s.count > 0);
  const rankReason = `排第 ${hypothesis.rank} 位：关联告警 ${signalCount('ALERT')} 条${
    signals.length > 0 ? ` · ${signals.map((s) => `${s.label} ${s.count}`).join(' · ')}` : ''
  }`;

  return (
    <li
      className={`rounded-[10px] border bg-surface px-3 py-2.5 transition-colors ${
        accepted
          ? 'border-ok/45 bg-ok-soft/25'
          : rejected
            ? 'border-border/80 opacity-70'
            : 'border-border/90'
      }`}
    >
      <div className="flex items-start gap-2">
        <span className="mt-0.5 grid size-4 shrink-0 place-items-center rounded-[3px] bg-primary-soft font-mono text-[10px] text-primary">
          {hypothesis.rank}
        </span>
        <p className="text-[12px] font-medium leading-[1.45] text-text">{hypothesis.cause}</p>
        {accepted ? (
          <span className="ml-auto inline-flex shrink-0 items-center gap-0.5 rounded-[3px] bg-ok-soft px-1 py-px text-[10px] text-ok">
            <Check size={9} strokeWidth={3} />
            已采纳
          </span>
        ) : rejected ? (
          <span className="ml-auto shrink-0 rounded-[3px] bg-surface-muted px-1 py-px text-[10px] text-text-tertiary">
            已否决
          </span>
        ) : null}
      </div>

      <div className="mt-2 flex items-center gap-2">
        <div className="h-1 flex-1 overflow-hidden rounded-full bg-border/50">
          <div
            className="h-full rounded-full bg-linear-to-r from-primary/75 to-primary"
            style={{ width: `${percent}%` }}
          />
        </div>
        <span className="font-mono text-[10px] text-text-secondary">{percent}%</span>
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-text-tertiary">
        <span>{CATEGORY_LABEL[hypothesis.category] ?? hypothesis.category}</span>
        <span aria-hidden>·</span>
        <span
          className={isRule ? 'text-warn' : 'text-primary'}
          title={isRule ? '规则引擎结论（无模型参与）' : `模型：${hypothesis.model ?? '未知'}`}
        >
          {isRule ? '规则引擎' : '模型研判'}
        </span>
        <span aria-hidden>·</span>
        <span>证据 {hypothesis.evidenceCount} 条</span>
      </div>

      <p
        className="mt-1 text-[9.5px] leading-4 text-text-tertiary"
        title="排序依据：证据数量与类型"
      >
        {rankReason}
      </p>

      {hypothesis.evidence.length > 0 ? (
        <ul className="mt-2 space-y-1 border-t border-border pt-2">
          {hypothesis.evidence.map((item) => (
            <li key={`${item.type}-${item.ref}`} className="flex gap-1.5 text-[10.5px] leading-4">
              <span className="shrink-0 rounded-[3px] bg-surface-muted px-1 font-mono text-[9px] text-text-secondary">
                {EVIDENCE_LABEL[item.type] ?? item.type}
              </span>
              <span className="min-w-0 break-words text-text-secondary">
                {item.desc}
                <span className="ml-1 font-mono text-[9px] text-text-tertiary">
                  #{shortRef(item.ref)}
                </span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {hypothesis.verifySteps.length > 0 ? (
        incidentId ? (
          <VerifyChecklist
            incidentId={incidentId}
            hypothesisId={hypothesis.id}
            verify={hypothesis.verify}
          />
        ) : (
          <div className="mt-2 border-t border-border pt-2">
            <p className="flex items-center gap-1 text-[10px] font-medium text-text-secondary">
              <ListChecks size={11} strokeWidth={2} className="text-text-tertiary" />
              验证步骤
            </p>
            <ol className="mt-1 space-y-0.5">
              {hypothesis.verifySteps.map((step, index) => (
                <li key={step} className="flex gap-1.5 text-[10.5px] leading-4 text-text-secondary">
                  <span className="font-mono text-[9px] text-text-tertiary">{index + 1}.</span>
                  <span className="min-w-0 break-words">{step}</span>
                </li>
              ))}
            </ol>
          </div>
        )
      ) : null}

      {hypothesis.actions.length > 0 ? (
        <div className="mt-2 border-t border-border pt-2">
          <p className="flex items-center gap-1 text-[10px] font-medium text-text-secondary">
            <Wrench size={11} strokeWidth={2} className="text-text-tertiary" />
            处置建议
          </p>
          <ul className="mt-1 space-y-1">
            {hypothesis.actions.map((action) => (
              <li key={action.action} className="flex items-start gap-1.5 text-[10.5px] leading-4">
                <span
                  className={`shrink-0 font-mono text-[9px] ${RISK_STYLE[action.risk] ?? 'text-text-tertiary'}`}
                >
                  {RISK_LABEL[action.risk] ?? action.risk}
                </span>
                <span className="min-w-0 break-words text-text-secondary">
                  {action.action}
                  {action.requiresApproval ? (
                    <span className="ml-1 text-[9px] text-warn">需审批</span>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {onVerdict ? (
        <div className="mt-2 flex items-center gap-1.5 border-t border-border pt-2">
          <button
            type="button"
            onClick={() => onVerdict(accepted ? null : 'ACCEPTED')}
            disabled={verdictPending}
            className={`inline-flex h-6 items-center gap-1 rounded-[5px] border px-1.5 text-[10.5px] transition-colors disabled:opacity-50 ${
              accepted
                ? 'border-ok/40 bg-ok-soft text-ok'
                : 'border-border-strong bg-surface text-text-secondary hover:bg-surface-muted hover:text-text'
            }`}
          >
            <Check size={10} strokeWidth={2.5} />
            {accepted ? '已采纳' : '采纳为首要根因'}
          </button>
          <button
            type="button"
            onClick={() => onVerdict(rejected ? null : 'REJECTED')}
            disabled={verdictPending}
            className={`inline-flex h-6 items-center gap-1 rounded-[5px] border px-1.5 text-[10.5px] transition-colors disabled:opacity-50 ${
              rejected
                ? 'border-border-strong bg-surface-muted text-text'
                : 'border-border-strong bg-surface text-text-secondary hover:bg-surface-muted hover:text-text'
            }`}
          >
            <X size={10} strokeWidth={2.5} />
            {rejected ? '已否决' : '否决'}
          </button>
          {hypothesis.verdict ? (
            <button
              type="button"
              onClick={() => onVerdict(null)}
              disabled={verdictPending}
              className="ml-auto text-[10px] text-text-tertiary hover:text-text disabled:opacity-50"
            >
              撤销裁决
            </button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/** 校验统计条：把"丢了多少、为什么丢"摆到明面上，这是可信度的一部分 */
export function VerifyBadge({
  stats,
  dropped,
}: {
  stats: { rawEvidence: number; validEvidence: number; relevanceRate: number } | null;
  dropped: readonly { cause: string; reason: string; detail?: string }[];
}) {
  if (!stats) return null;
  const allValid = dropped.length === 0;

  return (
    <div className="rounded-[6px] bg-surface-muted px-2 py-1.5">
      <p className="flex items-center gap-1 text-[10px] text-text-secondary">
        {allValid ? (
          <CheckCircle2 size={11} strokeWidth={2} className="text-ok" />
        ) : (
          <AlertTriangle size={11} strokeWidth={2} className="text-warn" />
        )}
        证据校验：{stats.validEvidence}/{stats.rawEvidence} 有效
        {dropped.length > 0 ? ` · 丢弃 ${dropped.length} 条假设` : ''}
      </p>
      {dropped.length > 0 ? (
        <ul className="mt-1 space-y-0.5">
          {dropped.map((item) => (
            <li
              key={`${item.reason}-${item.cause}`}
              className="text-[10px] leading-4 text-text-tertiary"
            >
              <span className="font-mono text-[9px] text-danger">{item.reason}</span>{' '}
              {item.detail ?? item.cause}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function EmptyHypotheses({
  missingInfo,
  onAnalyze,
  pending,
}: {
  missingInfo: readonly string[];
  onAnalyze: () => void;
  pending: boolean;
}) {
  return (
    <div className="rounded-[8px] border border-dashed border-border-strong px-3 py-3">
      <p className="flex items-center gap-1.5 text-[12px] font-medium text-text">
        <GitBranch size={13} strokeWidth={2} className="text-text-tertiary" />
        证据不足，未给出根因
      </p>
      <p className="mt-1 text-[11px] leading-4 text-text-tertiary">
        所有假设都未通过证据校验。系统不会为了"有结论"而编造结论。
      </p>
      {missingInfo.length > 0 ? (
        <ul className="mt-2 space-y-0.5">
          {missingInfo.map((item) => (
            <li key={item} className="text-[10.5px] leading-4 text-text-secondary">
              · {item}
            </li>
          ))}
        </ul>
      ) : null}
      <button
        type="button"
        onClick={onAnalyze}
        disabled={pending}
        className="mt-2 h-7 w-full rounded-[6px] border border-border bg-surface text-[11px] text-text-secondary hover:bg-surface-muted disabled:opacity-50"
      >
        {pending ? '研判中…' : '补充证据后重新研判'}
      </button>
    </div>
  );
}
