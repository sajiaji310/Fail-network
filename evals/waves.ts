import type { MaterializedChange, ScenarioSpec } from '../src/modules/ingest/scenario';
import { materialize } from '../src/modules/ingest/scenario';
import { ingestAlerts } from '../src/modules/ingest/service';
import { runCorrelation } from '../src/modules/correlation/service';
import { db } from '../src/lib/db';

/**
 * 按波次注入并逐波聚合（评测专用）。
 *
 * 一次性注入全部告警再聚合，等于假设"所有告警在同一个瞬间到达" —— 这会掩盖
 * 跨窗口问题：静默 30 分钟后的同指纹上报本应生成新周期，但一次性注入时旧周期
 * 在聚合之前就被 RESOLVED 了，二次收敛规则根本没机会触发。
 *
 * 这里按 `minuteFromStart` 的切分点分批入库，每批之后跑一次聚合，
 * 复现"值班期间持续收告警"的真实时序。
 */
export async function runScenarioInWaves(
  spec: ScenarioSpec,
  waves: readonly number[],
  opts: { seed?: number; now?: Date; source?: string } = {},
): Promise<{ alertTotal: number; waves: number[] }> {
  const materialized = materialize(spec, { seed: opts.seed, now: opts.now });
  const source = opts.source ?? `eval-waves:${spec.name}`;
  const offsets = spec.alerts.map((a) => a.minuteFromStart);

  await writeChanges(materialized.changes);

  const cuts = [...new Set(waves)].sort((a, b) => a - b);
  const bounds: { from: number; to: number }[] = [];
  let previous = -1;
  for (const cut of cuts) {
    bounds.push({ from: previous, to: cut });
    previous = cut;
  }
  bounds.push({ from: previous, to: Number.POSITIVE_INFINITY });

  for (const bound of bounds) {
    const batch = materialized.alerts.filter((_, index) => {
      const offset = offsets[index] ?? 0;
      return offset > bound.from && offset <= bound.to;
    });
    if (batch.length === 0) continue;
    await ingestAlerts(source, batch);
    // 每波用同一个 now：波次之间的时间差由告警自身的时间戳表达，
    // 聚合时刻不能跟着往前推，否则第一波会被判成"两小时前的旧数据"
    await runCorrelation(opts.now);
  }

  return { alertTotal: materialized.alerts.length, waves: cuts };
}

async function writeChanges(changes: readonly MaterializedChange[]): Promise<void> {
  if (changes.length === 0) return;
  const names = [...new Set(changes.map((c) => c.deviceName))];
  const devices = await db.device.findMany({
    where: { name: { in: names } },
    select: { id: true, name: true },
  });
  const idByName = new Map(devices.map((d) => [d.name, d.id]));
  for (const change of changes) {
    const deviceId = idByName.get(change.deviceName);
    if (!deviceId) continue;
    await db.changeRecord.create({
      data: {
        deviceId,
        kind: change.kind,
        content: change.content,
        operator: change.operator,
        changedAt: change.changedAt,
      },
    });
  }
}
