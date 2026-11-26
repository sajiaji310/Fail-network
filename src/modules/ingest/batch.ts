import { db } from '@/lib/db';
import type { IngestBatchStatus } from '@prisma/client';
import { ingestAlerts, type IngestResult } from './service';
import type { RawAlert } from './schema';

/**
 * 导入批处理（评审第 4 阶段「导入改为批处理/异步任务，提供批次状态」）。
 *
 * 三条边界：
 * 1. **小批量保持同步**：`INGEST_SYNC_LIMIT`（默认 500 行）以下直接跑完再返回，
 *    调用方拿到的结果和以前一模一样。真实数据源的首批回填才是几万条的量级，
 *    为了它把所有调用方都改成"先轮询"不划算。
 * 2. **状态落库，执行在进程内**：批次行是事实源，刷新页面也看得到进度；
 *    但推进循环跑在本进程里 —— 多副本或 serverless 下进程重启会让批次停在 RUNNING。
 *    因此每次推进都写 `processed`，超时未完成由 `markStaleBatches()` 标记失败，
 *    而不是假装还在跑。
 * 3. **分块 + 主动让出事件循环**：每 200 行 `setImmediate` 一次。
 *    一个 3 万行的 POST 如果一路 await 下来，Node 仍能响应，但 Prisma 连接池会被一条
 *    长事务串占满；分块让别的请求有机会插进来。
 */

export const SYNC_ALERT_LIMIT = Number(process.env.INGEST_SYNC_LIMIT ?? 500);
export const CHUNK_SIZE = Number(process.env.INGEST_CHUNK_SIZE ?? 200);
const ISSUE_LIMIT = 200;
/** 超过这个时间仍在 RUNNING 的批次视为进程已死 */
const STALE_MS = 10 * 60_000;

export type SubmitInput = {
  source: string;
  kind: string;
  alerts: readonly RawAlert[];
  tenantId: string;
  createdBy: string | null;
};

export type SubmitResult =
  { mode: 'sync'; result: IngestResult } | { mode: 'async'; batchId: string; total: number };

function emptyResult(source: string): IngestResult {
  return {
    source,
    accepted: 0,
    deduped: 0,
    resolved: 0,
    suppressed: 0,
    retroSuppressed: 0,
    autoClosedIncidents: 0,
    failed: 0,
    issues: [],
  };
}

function mergeInto(target: IngestResult, chunk: IngestResult): void {
  target.accepted += chunk.accepted;
  target.deduped += chunk.deduped;
  target.resolved += chunk.resolved;
  target.suppressed += chunk.suppressed;
  target.retroSuppressed += chunk.retroSuppressed;
  target.autoClosedIncidents += chunk.autoClosedIncidents;
  target.failed += chunk.failed;
  if (target.issues.length < ISSUE_LIMIT) {
    const room = ISSUE_LIMIT - target.issues.length;
    target.issues.push(...chunk.issues.slice(0, room));
  }
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** 同步跑完（小批量 / 测试 / 脚本用），并可选地把进度写进批次行 */
export async function runBatchNow(batchId: string, input: SubmitInput): Promise<IngestResult> {
  const total = input.alerts.length;
  const startedAt = new Date();
  await db.ingestBatch.update({
    where: { id: batchId },
    data: { status: 'RUNNING', startedAt, total },
  });

  const aggregate = emptyResult(input.source);
  try {
    for (let offset = 0; offset < total; offset += CHUNK_SIZE) {
      const chunk = input.alerts.slice(offset, offset + CHUNK_SIZE);
      const result = await ingestAlerts(input.source, chunk, { tenantId: input.tenantId });
      mergeInto(aggregate, result);

      const processed = Math.min(total, offset + chunk.length);
      await db.ingestBatch.update({
        where: { id: batchId },
        data: {
          processed,
          accepted: aggregate.accepted,
          deduped: aggregate.deduped,
          suppressed: aggregate.suppressed,
          retroSuppressed: aggregate.retroSuppressed,
          autoClosedIncidents: aggregate.autoClosedIncidents,
          failed: aggregate.failed,
        },
      });
      if (processed < total) await yieldToEventLoop();
    }

    await db.ingestBatch.update({
      where: { id: batchId },
      data: {
        status: 'DONE',
        processed: total,
        finishedAt: new Date(),
        durationMs: Date.now() - startedAt.getTime(),
        issues: aggregate.issues.slice(0, ISSUE_LIMIT),
      },
    });
    return aggregate;
  } catch (error) {
    await db.ingestBatch.update({
      where: { id: batchId },
      data: {
        status: 'FAILED',
        error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
        finishedAt: new Date(),
        durationMs: Date.now() - startedAt.getTime(),
        issues: aggregate.issues.slice(0, ISSUE_LIMIT),
      },
    });
    throw error;
  }
}

/**
 * 提交导入。超过阈值转异步：先落批次行，再在后台推进，立即返回 batchId。
 *
 * 后台任务用 `void promise` 而不是 `await`：客户端要的是 202 和批次号，
 * 不是三分钟后的一次超时。失败已经写进批次行的 error 字段，不会静默丢失。
 */
export async function submitIngest(input: SubmitInput): Promise<SubmitResult> {
  if (input.alerts.length <= SYNC_ALERT_LIMIT) {
    const batch = await db.ingestBatch.create({
      data: {
        source: input.source,
        kind: input.kind,
        total: input.alerts.length,
        tenantId: input.tenantId,
        createdBy: input.createdBy,
        status: 'QUEUED',
      },
      select: { id: true },
    });
    const result = await runBatchNow(batch.id, input);
    return { mode: 'sync', result };
  }

  const batch = await db.ingestBatch.create({
    data: {
      source: input.source,
      kind: input.kind,
      total: input.alerts.length,
      tenantId: input.tenantId,
      createdBy: input.createdBy,
      status: 'QUEUED',
    },
    select: { id: true },
  });

  void runBatchNow(batch.id, input).catch(() => {
    // 已在 runBatchNow 里落库，这里只负责吞掉未处理的 rejection
  });

  return { mode: 'async', batchId: batch.id, total: input.alerts.length };
}

/** 进程重启后清理"看起来还在跑"的批次：状态诚实比状态好看重要 */
export async function markStaleBatches(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - STALE_MS);
  const result = await db.ingestBatch.updateMany({
    where: {
      status: { in: ['QUEUED', 'RUNNING'] },
      // QUEUED 的 startedAt 还是 null，用 createdAt 兜住"入队就没再动过"的情况
      OR: [{ startedAt: { lt: cutoff } }, { startedAt: null, createdAt: { lt: cutoff } }],
    },
    data: { status: 'FAILED', error: '批次中断：进程在任务完成前退出' },
  });
  return result.count;
}

export type BatchView = {
  id: string;
  source: string;
  kind: string;
  status: IngestBatchStatus;
  total: number;
  processed: number;
  accepted: number;
  deduped: number;
  suppressed: number;
  retroSuppressed: number;
  autoClosedIncidents: number;
  failed: number;
  error: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  durationMs: number | null;
  /** 0–100，四舍五入 */
  progress: number;
};

export function toBatchView(row: {
  id: string;
  source: string;
  kind: string;
  status: IngestBatchStatus;
  total: number;
  processed: number;
  accepted: number;
  deduped: number;
  suppressed: number;
  retroSuppressed: number;
  autoClosedIncidents: number;
  failed: number;
  error: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  durationMs: number | null;
}): BatchView {
  const progress = row.total > 0 ? Math.round((row.processed / row.total) * 100) : 0;
  return { ...row, progress };
}

export async function listBatches(tenantId: string, limit = 20): Promise<BatchView[]> {
  const rows = await db.ingestBatch.findMany({
    where: { tenantId },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
  return rows.map(toBatchView);
}

export async function getBatch(id: string, tenantId: string): Promise<BatchView | null> {
  const row = await db.ingestBatch.findFirst({ where: { id, tenantId } });
  return row ? toBatchView(row) : null;
}
