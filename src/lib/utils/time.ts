import { format, formatDistanceToNowStrict } from 'date-fns';
import { zhCN } from 'date-fns/locale';

/**
 * 时间展示（文档 11.3：相对时间 + hover 显示绝对时间）。
 *
 * 这些函数同时跑在服务端渲染和客户端渲染里，两次调用会有秒级差异
 * （"3 分钟前" → "4 分钟前"），因此使用它们的 <time> 元素需带
 * `suppressHydrationWarning`，避免无意义的 hydration 警告。
 */

export function toDate(value: string | Date): Date {
  return value instanceof Date ? value : new Date(value);
}

/** 相对时间：3 分钟前 / 2 小时前 / 4 天前 */
export function relTime(value: string | Date, now?: Date): string {
  return formatDistanceToNowStrict(toDate(value), {
    addSuffix: true,
    locale: zhCN,
    ...(now ? { baseDate: now } : {}),
  });
}

/** 绝对时间，hover 提示用 */
export function absTime(value: string | Date): string {
  return format(toDate(value), 'yyyy-MM-dd HH:mm:ss');
}

/** 表内窄列用的时分秒 */
export function clockTime(value: string | Date): string {
  return format(toDate(value), 'HH:mm:ss');
}

/** 持续时长：42 分钟 / 1 小时 07 分 / 3 天 2 小时 */
export function duration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const total = Math.floor(seconds);
  if (total < 60) return `${total} 秒`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const restMin = minutes % 60;
  if (hours < 24)
    return restMin ? `${hours} 小时 ${String(restMin).padStart(2, '0')} 分` : `${hours} 小时`;
  const days = Math.floor(hours / 24);
  return `${days} 天 ${hours % 24} 小时`;
}

/** 从开始到结束（未结束则算到 now）的秒数 */
export function elapsedSeconds(
  start: string | Date,
  end?: string | Date | null,
  now?: Date,
): number {
  const from = toDate(start).getTime();
  const to = end ? toDate(end).getTime() : (now ?? new Date()).getTime();
  return Math.max(0, Math.round((to - from) / 1000));
}
