/**
 * 研判阶段进度（评审 5.2 / 第 3 阶段「对研判过程提供阶段进度，之后再升级为 SSE」）。
 *
 * 为什么是进程内表而不是落库：
 * 进度是**一次请求的生命周期数据**，不是业务事实。落库意味着每次研判
 * 4 次写 + 1 次清理，还得处理崩溃残留的 RUNNING 行。进程内的代价是
 * 多实例部署下轮询可能打到另一个进程 —— 这一点在下面标注了，
 * 升级 SSE 时顺手换成 Redis 即可，接口形状不变。
 *
 * 保留 10 分钟：足够前端在研判结束后读一次"各阶段耗时"，
 * 又不会让内存随事件数无限增长。
 */

export type AnalysisStage = 'CONTEXT' | 'REASONING' | 'VERIFY' | 'PERSIST' | 'DONE' | 'FAILED';

export const STAGE_LABEL: Record<AnalysisStage, string> = {
  CONTEXT: '装配上下文',
  REASONING: '模型推理',
  VERIFY: '证据校验',
  PERSIST: '落库',
  DONE: '完成',
  FAILED: '失败',
};

export const STAGE_ORDER: readonly AnalysisStage[] = ['CONTEXT', 'REASONING', 'VERIFY', 'PERSIST'];

export type StageRecord = {
  stage: AnalysisStage;
  label: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
};

export type AnalysisProgress = {
  incidentId: string;
  status: 'RUNNING' | 'DONE' | 'FAILED';
  /** 当前正在进行的阶段；结束后为 DONE / FAILED */
  stage: AnalysisStage;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  stages: StageRecord[];
  error: string | null;
};

const TTL_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 200;

/**
 * 必须挂在 globalThis 上，不能用模块级变量：
 * Next 按路由把服务端代码打成独立 chunk，`analyze/route` 与 `analyze/status/route`
 * 各自持有一份模块实例 —— 用模块变量会出现"POST 写进去、GET 读不到"的假空表。
 * 这和 Prisma Client 在 dev 下必须单例是同一类问题。
 */
const globalForProgress = globalThis as unknown as {
  __netscopeAnalysisProgress?: Map<string, AnalysisProgress>;
};
const registry: Map<string, AnalysisProgress> = (globalForProgress.__netscopeAnalysisProgress ??=
  new Map());

function prune(now: number): void {
  for (const [key, value] of registry) {
    const end = value.finishedAt ? new Date(value.finishedAt).getTime() : now;
    if (now - end > TTL_MS) registry.delete(key);
  }
  // 极端情况（大量并发研判）下按插入顺序丢最老的，防止内存无界
  while (registry.size > MAX_ENTRIES) {
    const oldest = registry.keys().next();
    if (oldest.done) break;
    registry.delete(oldest.value);
  }
}

/** 开始一次研判；同一事件重复触发时覆盖上一条（最新的才是真实进度） */
export function beginAnalysis(incidentId: string, now: Date = new Date()): AnalysisProgress {
  prune(now.getTime());
  const progress: AnalysisProgress = {
    incidentId,
    status: 'RUNNING',
    stage: 'CONTEXT',
    startedAt: now.toISOString(),
    finishedAt: null,
    durationMs: null,
    stages: [],
    error: null,
  };
  registry.set(incidentId, progress);
  return progress;
}

function closeOpenStage(progress: AnalysisProgress, at: Date): void {
  const last = progress.stages[progress.stages.length - 1];
  if (last && last.finishedAt === null) {
    last.finishedAt = at.toISOString();
    last.durationMs = new Date(last.finishedAt).getTime() - new Date(last.startedAt).getTime();
  }
}

/** 进入下一阶段：先关掉上一段，再开新段 */
export function enterStage(
  incidentId: string,
  stage: AnalysisStage,
  now: Date = new Date(),
): AnalysisProgress | null {
  const progress = registry.get(incidentId);
  if (!progress) return null;
  closeOpenStage(progress, now);
  progress.stage = stage;
  if (stage !== 'DONE' && stage !== 'FAILED') {
    progress.stages.push({
      stage,
      label: STAGE_LABEL[stage],
      startedAt: now.toISOString(),
      finishedAt: null,
      durationMs: null,
    });
  }
  return progress;
}

export function finishAnalysis(
  incidentId: string,
  now: Date = new Date(),
): AnalysisProgress | null {
  const progress = registry.get(incidentId);
  if (!progress) return null;
  closeOpenStage(progress, now);
  progress.status = 'DONE';
  progress.stage = 'DONE';
  progress.finishedAt = now.toISOString();
  progress.durationMs = now.getTime() - new Date(progress.startedAt).getTime();
  return progress;
}

export function failAnalysis(
  incidentId: string,
  error: string,
  now: Date = new Date(),
): AnalysisProgress | null {
  const progress = registry.get(incidentId);
  if (!progress) return null;
  closeOpenStage(progress, now);
  progress.status = 'FAILED';
  progress.stage = 'FAILED';
  progress.finishedAt = now.toISOString();
  progress.durationMs = now.getTime() - new Date(progress.startedAt).getTime();
  progress.error = error.slice(0, 300);
  return progress;
}

export function getAnalysisProgress(incidentId: string): AnalysisProgress | null {
  prune(Date.now());
  return registry.get(incidentId) ?? null;
}

/** 仅供测试：清空注册表，避免用例之间互相污染 */
export function resetAnalysisProgress(): void {
  registry.clear();
}
