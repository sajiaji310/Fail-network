import type { ContextBundle } from './context';

/**
 * 上下文裁剪（文档 10.1 后半段）。单独成文件是为了能被单测直接喂数据，
 * 不用连库；`context.ts` 只负责取数。
 */

export const CONTEXT_CHAR_BUDGET = 13_000; // ≈ 6k tokens（中文约 2.2 字/token）
export const MAX_ALERTS_IN_CONTEXT = 20;
export const MAX_ALERTS_TRIMMED = 10;
export const MAX_METRICS_IN_CONTEXT = 12;
export const MAX_CASES_IN_CONTEXT = 3;

const SEVERITY_RANK = { P0: 4, P1: 3, P2: 2, P3: 1 } as const;

type Trimmable = Pick<ContextBundle, 'alerts' | 'links' | 'metrics' | 'changes' | 'cases'>;

/** 上下文体积估算：JSON 长度 / 2.2。只用于裁剪决策，不需要精确 */
export function measureBundle(bundle: Trimmable): number {
  const size = (value: unknown) => JSON.stringify(value).length;
  return Math.ceil(
    (size(bundle.alerts) +
      size(bundle.links) +
      size(bundle.metrics) +
      size(bundle.changes) +
      size(bundle.cases)) /
      2.2,
  );
}

export function sortContextAlerts<
  T extends { severity: 'P0' | 'P1' | 'P2' | 'P3'; firstSeen: string; id: string },
>(a: T, b: T): number {
  return (
    SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
    a.firstSeen.localeCompare(b.firstSeen) ||
    a.id.localeCompare(b.id)
  );
}

/**
 * 超预算裁剪（纯函数）。顺序即文档 10.1：指标 → 历史 → 拓扑（降到 1 跳）→ 告警（Top10）。
 * 四步都裁完仍超预算就停手：宁可让模型看长一点的 prompt，不可把证据削光。
 */
export function trimBundle(
  bundle: ContextBundle,
  budgetChars = CONTEXT_CHAR_BUDGET,
): ContextBundle {
  let next: ContextBundle = { ...bundle, trim: { trimmed: [], chars: 0 } };
  const mark = (label: string) => {
    if (!next.trim.trimmed.includes(label)) next.trim.trimmed.push(label);
  };

  const reducers: { label: string; apply: () => boolean }[] = [
    {
      label: 'metrics',
      apply: () => {
        if (next.metrics.length === 0) return false;
        next = { ...next, metrics: [] };
        mark('metrics');
        return true;
      },
    },
    {
      label: 'cases',
      apply: () => {
        const keep = next.cases.filter((c) => c.relevant).slice(0, 1);
        if (keep.length === next.cases.length) return false;
        next = { ...next, cases: keep };
        mark('cases');
        return true;
      },
    },
    {
      label: 'topology',
      apply: () => {
        const direct = next.links.filter((l) => l.hopsToIncident <= 1);
        if (direct.length === next.links.length) return false;
        next = { ...next, links: direct };
        mark('topology');
        return true;
      },
    },
    {
      label: 'alerts',
      apply: () => {
        if (next.alerts.length <= MAX_ALERTS_TRIMMED) return false;
        next = {
          ...next,
          alerts: [...next.alerts].sort(sortContextAlerts).slice(0, MAX_ALERTS_TRIMMED),
        };
        mark('alerts');
        return true;
      },
    },
  ];

  for (let guard = 0; guard < 16; guard++) {
    const chars = measureBundle(next);
    if (chars <= budgetChars) break;
    const applied = reducers.find((r) => r.apply());
    if (!applied) break;
  }

  return { ...next, trim: { trimmed: next.trim.trimmed, chars: measureBundle(next) } };
}
