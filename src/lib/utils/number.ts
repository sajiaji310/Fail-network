/** 数字格式化。集中在 utils 里，避免每个页面各写一遍 `.toFixed(1) + '%'` */

/**
 * 比例 → 百分比字符串。
 * 不自动四舍五入到整数：接受率 59.4% 和 60% 是两个结论（前者没达标），不该看起来一样。
 */
export function percent(ratio: number, digits = 1): string {
  return `${(ratio * 100).toFixed(digits)}%`;
}

/** 大数字缩写：1234 → 1.2k，方便卡片上一眼看清量级 */
export function compactNumber(value: number): string {
  if (Math.abs(value) < 1000) return String(value);
  if (Math.abs(value) < 1_000_000) return `${(value / 1000).toFixed(1)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}
