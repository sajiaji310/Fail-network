import { cn } from '@/lib/utils/cn';
import { absTime, relTime } from '@/lib/utils/time';
import { deviceLayerLabel } from '@/modules/alerts/labels';
import type { IncidentChange, IncidentDevice, HypothesisView } from '@/modules/incidents/detail';
import { changeKindLabel } from '@/modules/incidents/timeline';

/**
 * 右栏：根因与证据面板。
 *
 * T06 只做"占位 + 已有证据"，不做任何推理：可疑变更与影响面都是库里已有的事实，
 * 研判结论要等 T07。提前把证据位置占好，是为了避免 T07 上线时整页重排。
 */

const CATEGORY_LABEL: Record<string, string> = {
  HARDWARE: '硬件',
  CONFIG: '配置',
  LINK: '链路',
  CAPACITY: '容量',
  UPSTREAM: '上游',
  OTHER: '其它',
};

export type HypothesisPanelProps = {
  hypotheses: readonly HypothesisView[];
  changes: readonly IncidentChange[];
  devices: readonly IncidentDevice[];
  selectedDeviceId?: string | null;
  onSelectDevice?: (deviceId: string) => void;
};

export function HypothesisPanel({
  hypotheses,
  changes,
  devices,
  selectedDeviceId = null,
  onSelectDevice,
}: HypothesisPanelProps) {
  return (
    <div className="space-y-4">
      <section>
        <div className="mb-2 flex items-baseline justify-between">
          <h2 className="text-[13px] font-medium">根因研判</h2>
          <span className="font-mono text-[10px] text-text-tertiary">T07</span>
        </div>

        {hypotheses.length === 0 ? (
          <div className="rounded-[8px] border border-dashed border-border-strong px-3 py-4">
            <p className="text-[12px] font-medium text-text">尚未研判</p>
            <p className="mt-1 text-[11px] leading-4 text-text-tertiary">
              规则 fallback + 模型研判在 T07 接入。现在可以先看下方变更与影响面，人工判断根因。
            </p>
            <button
              type="button"
              disabled
              className="mt-3 h-8 w-full cursor-not-allowed rounded-[6px] border border-border bg-surface-muted text-[12px] text-text-tertiary"
              title="T07 提供 POST /api/v1/incidents/[id]/analyze"
            >
              开始研判（T07）
            </button>
          </div>
        ) : (
          <ol className="space-y-2">
            {hypotheses.map((h) => (
              <li key={h.id} className="rounded-[8px] border border-border bg-surface px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className="grid size-4 place-items-center rounded-[3px] bg-primary-soft font-mono text-[10px] text-primary">
                    {h.rank}
                  </span>
                  <span className="text-[12px] font-medium text-text">{h.cause}</span>
                  <span className="ml-auto font-mono text-[10px] text-text-tertiary">
                    {Math.round(h.confidence * 100)}%
                  </span>
                </div>
                <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-surface-muted">
                  <div
                    className="h-full bg-primary"
                    style={{ width: `${Math.round(h.confidence * 100)}%` }}
                  />
                </div>
                <p className="mt-1.5 text-[11px] text-text-tertiary">
                  {CATEGORY_LABEL[h.category] ?? h.category} · {h.source} · 证据 {h.evidenceCount}{' '}
                  条
                </p>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-[13px] font-medium">
          可疑变更
          <span className="ml-1.5 font-mono text-[10px] font-normal text-text-tertiary">
            事件前 2h 内
          </span>
        </h2>
        {changes.length === 0 ? (
          <p className="rounded-[8px] border border-dashed border-border px-3 py-3 text-[11px] text-text-tertiary">
            该窗口内没有变更记录。若上游系统未接入变更数据，这里为空不代表没改过配置。
          </p>
        ) : (
          <ul className="space-y-1.5">
            {changes.map((change) => (
              <li
                key={change.id}
                className="rounded-[8px] border border-border bg-surface px-3 py-2"
              >
                <div className="flex items-center gap-1.5">
                  <span className="rounded-[3px] bg-[#FFFAEB] px-1 py-px text-[10px] text-warn">
                    {changeKindLabel(change.kind)}
                  </span>
                  <span className="font-mono text-[11px] text-text">{change.deviceName}</span>
                  <time
                    dateTime={change.changedAt}
                    title={absTime(change.changedAt)}
                    className="ml-auto font-mono text-[10px] text-text-tertiary"
                    suppressHydrationWarning
                  >
                    {relTime(change.changedAt)}
                  </time>
                </div>
                <p className="mt-1 text-[11px] leading-4 text-text-secondary">{change.content}</p>
                {change.operator ? (
                  <p className="mt-0.5 text-[10px] text-text-tertiary">操作人 {change.operator}</p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-[13px] font-medium">
          影响面
          <span className="ml-1.5 font-mono text-[10px] font-normal text-text-tertiary">
            {devices.length} 台设备
          </span>
        </h2>
        <ul className="space-y-1">
          {devices.map((device) => (
            <li key={device.id}>
              <button
                type="button"
                onClick={() => onSelectDevice?.(device.id)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-[6px] px-2 py-1.5 text-left transition-colors',
                  selectedDeviceId === device.id ? 'bg-primary-soft' : 'hover:bg-surface-muted',
                )}
              >
                <span className="font-mono text-[11px] text-text">{device.name}</span>
                <span className="text-[10px] text-text-tertiary">
                  {deviceLayerLabel(device.layer)}
                </span>
                <span className="ml-auto font-mono text-[10px] text-text-tertiary">
                  {device.suppressedCount > 0
                    ? `${device.alertCount} 条（${device.suppressedCount} 抑制）`
                    : `${device.alertCount} 条`}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
