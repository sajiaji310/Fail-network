import Link from 'next/link';
import type { AlertStatus, Severity } from '@prisma/client';
import { AlertStatusPill, SeverityPill } from '@/components/ui/badges';
import { absTime, clockTime, relTime } from '@/lib/utils/time';
import { alertTypeLabel } from '@/modules/alerts/labels';
import { cn } from '@/lib/utils/cn';

/**
 * 告警表格（文档 11.1：可筛选表格，行内跳事件）。
 *
 * 不带 'use client'：既有服务端页面直接用，也被客户端工作台引用。
 * 选中设备靠 prop 传入而不是内部 state——表格不持状态，筛选逻辑留在页面。
 */

export type AlertTableRow = {
  id: string;
  type: string;
  severity: Severity;
  status: AlertStatus;
  message: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  deviceId: string;
  deviceName: string;
  incidentId?: string | null;
  suppressedByAlertId?: string | null;
};

export type AlertTableProps = {
  rows: readonly AlertTableRow[];
  selectedDeviceId?: string | null;
  onSelectDevice?: (deviceId: string) => void;
  /** 行点击：告警流页面跳到事件详情用 */
  incidentHrefOf?: (row: AlertTableRow) => string | null;
  emptyTitle?: string;
  emptyHint?: string;
  maxHeight?: number;
  className?: string;
};

export function AlertTable({
  rows,
  selectedDeviceId = null,
  onSelectDevice,
  incidentHrefOf,
  emptyTitle = '没有符合条件的告警',
  emptyHint = '换个状态或时间范围试试；也可以先注入一套故障剧本。',
  maxHeight,
  className,
}: AlertTableProps) {
  return (
    <div
      className={cn('overflow-auto rounded-[10px] border border-border bg-surface', className)}
      style={maxHeight ? { maxHeight } : undefined}
    >
      <table className="w-full border-collapse text-[12px]">
        <thead className="sticky top-0 z-10 bg-surface-muted text-left text-[11px] font-medium text-text-secondary">
          <tr>
            <th className="whitespace-nowrap px-3 py-2">时间</th>
            <th className="whitespace-nowrap px-3 py-2">设备</th>
            <th className="whitespace-nowrap px-3 py-2">告警</th>
            <th className="whitespace-nowrap px-3 py-2">级别</th>
            <th className="whitespace-nowrap px-3 py-2">状态</th>
            <th className="whitespace-nowrap px-3 py-2 text-right">次数</th>
            <th className="px-3 py-2">消息</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={7} className="px-3 py-10 text-center">
                <p className="text-[13px] font-medium text-text">{emptyTitle}</p>
                <p className="mt-1 text-[12px] text-text-tertiary">{emptyHint}</p>
              </td>
            </tr>
          ) : (
            rows.map((row) => {
              const href = incidentHrefOf?.(row) ?? null;
              const selected = selectedDeviceId === row.deviceId;
              return (
                <tr
                  key={row.id}
                  className={cn(
                    'border-t border-border align-middle',
                    selected ? 'bg-primary-soft' : 'hover:bg-surface-muted',
                  )}
                >
                  <td className="whitespace-nowrap px-3 py-1.5 font-mono text-[11px] text-text-secondary">
                    <time
                      dateTime={row.firstSeen}
                      title={absTime(row.firstSeen)}
                      suppressHydrationWarning
                    >
                      {clockTime(row.firstSeen)}
                    </time>
                    <span className="ml-1.5 text-text-tertiary" suppressHydrationWarning>
                      {relTime(row.firstSeen)}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5">
                    {onSelectDevice ? (
                      <button
                        type="button"
                        onClick={() => onSelectDevice(row.deviceId)}
                        className={cn(
                          'rounded-[4px] px-1 font-mono text-[11px] transition-colors',
                          selected ? 'text-primary' : 'text-text hover:text-primary',
                          'hover:bg-primary-soft',
                        )}
                      >
                        {row.deviceName}
                      </button>
                    ) : (
                      <span className="font-mono text-[11px] text-text">{row.deviceName}</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5">
                    {href ? (
                      <Link href={href} className="text-text hover:text-primary hover:underline">
                        {alertTypeLabel(row.type)}
                      </Link>
                    ) : (
                      <span className="text-text">{alertTypeLabel(row.type)}</span>
                    )}
                    <span className="ml-1.5 font-mono text-[10px] text-text-tertiary">
                      {row.type}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5">
                    <SeverityPill severity={row.severity} compact />
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5">
                    <AlertStatusPill status={row.status} />
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono tabular text-[11px] text-text-secondary">
                    {row.count}
                  </td>
                  <td className="max-w-[320px] px-3 py-1.5 text-text-secondary">
                    <span className="line-clamp-1">{row.message}</span>
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}
