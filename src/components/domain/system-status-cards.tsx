import { format } from 'date-fns';
import { Card, CardTitle } from '@/components/ui/card';
import { StatusPill } from '@/components/ui/status-pill';
import { EVAL_TARGETS, getEvalSummary } from '@/modules/system/eval-summary';
import { getDataSummary, SEED_BASELINE } from '@/modules/system/service';

/**
 * 工程状态卡片（数据基线 / 评测基线）。
 *
 * 从概览页搬到这里（评审 5.1：T01-T09、评测基线、种子数据放到系统状态或设置页）。
 * 搬的是位置，不是内容 —— 值班的人不需要每天看 30 台设备有几条链路，
 * 但验收的人需要，所以放在设置页底部一个固定位置，随时可查。
 */

function Tile({
  label,
  value,
  suffix,
}: {
  label: string;
  value: number | string;
  suffix?: string;
}) {
  return (
    <div className="rounded-[10px] bg-surface-muted/75 px-3 py-2.5">
      <p className="text-[11.5px] text-text-secondary">{label}</p>
      <p className="mt-0.5 flex items-baseline gap-1">
        <span className="tabular font-mono text-[18px] leading-6">{value}</span>
        {suffix ? (
          <span className="font-mono text-[11px] text-text-tertiary">/ {suffix}</span>
        ) : null}
      </p>
    </div>
  );
}

export async function DataBaselineCard() {
  const data = await getDataSummary();
  return (
    <Card>
      <CardTitle
        hint={`基线 ${SEED_BASELINE.devices} / ${SEED_BASELINE.links} / ${SEED_BASELINE.cases}`}
      >
        数据基线
      </CardTitle>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: '设备', value: data.devices, base: SEED_BASELINE.devices },
          { label: '链路', value: data.links, base: SEED_BASELINE.links },
          { label: '历史案例', value: data.cases, base: SEED_BASELINE.cases },
          { label: '告警', value: data.alerts, base: null },
        ].map((item) => (
          <Tile
            key={item.label}
            label={item.label}
            value={item.value}
            suffix={item.base !== null ? String(item.base) : undefined}
          />
        ))}
      </div>
      <div className="mt-3 flex items-center gap-2 text-[12px] text-text-secondary">
        <StatusPill tone={data.seedReady ? 'ok' : 'warn'}>
          {data.seedReady ? '种子数据就位' : '待执行 npm run db:seed'}
        </StatusPill>
        <span className="text-text-tertiary">
          {data.alerts === 0
            ? '告警为 0 属正常：还没有接入数据'
            : '告警行数按「发生周期」计，同周期重复上报已折叠进 count'}
        </span>
      </div>
    </Card>
  );
}

export async function EvalBaselineCard() {
  const evalTest = await getEvalSummary('test');

  /**
   * 压缩比跟「这份数据集能压到的上限」比，不是跟固定 8:1 比：
   * test 集 54 条告警只标注了 9 个事件，完美聚类就是 6.0:1。
   */
  const compressionCeiling = evalTest?.compressionCeiling ?? null;
  const compressionEfficiency = evalTest?.compressionEfficiency ?? null;
  const compressionOk =
    compressionCeiling !== null && compressionEfficiency !== null
      ? compressionEfficiency >= 0.999
      : (evalTest?.compression ?? 0) >= EVAL_TARGETS.compression;

  return (
    <Card>
      <CardTitle
        hint={evalTest ? `留出集 ${evalTest.total} 个场景 · 调参全程只碰 dev 集` : '尚未跑分'}
      >
        评测基线
      </CardTitle>

      {evalTest ? (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              {
                label: 'Top1 命中率',
                value: `${(evalTest.top1Rate * 100).toFixed(1)}%`,
                target: `≥ ${EVAL_TARGETS.top1 * 100}%`,
                badge: evalTest.top1Rate >= EVAL_TARGETS.top1 ? '达标' : '未达标',
                ok: evalTest.top1Rate >= EVAL_TARGETS.top1,
              },
              {
                label: 'Top3 命中率',
                value: `${(evalTest.top3Rate * 100).toFixed(1)}%`,
                target: `≥ ${EVAL_TARGETS.top3 * 100}%`,
                badge: evalTest.top3Rate >= EVAL_TARGETS.top3 ? '达标' : '未达标',
                ok: evalTest.top3Rate >= EVAL_TARGETS.top3,
              },
              {
                label: '告警压缩比',
                value: `${evalTest.compression.toFixed(1)}:1`,
                target:
                  compressionCeiling !== null
                    ? `上限 ${compressionCeiling.toFixed(1)}:1`
                    : `≥ ${EVAL_TARGETS.compression}:1`,
                badge:
                  compressionCeiling === null
                    ? compressionOk
                      ? '达标'
                      : '未达标'
                    : compressionOk
                      ? '贴上上限'
                      : '仍有空间',
                ok: compressionOk,
              },
              {
                label: '全通过场景',
                value: `${evalTest.passed}/${evalTest.total}`,
                target: '全部',
                badge: evalTest.passed === evalTest.total ? '达标' : '有失败项',
                ok: evalTest.passed === evalTest.total,
              },
            ].map((item) => (
              <div key={item.label} className="rounded-[10px] bg-surface-muted/75 px-3 py-2.5">
                <p className="flex items-baseline gap-1.5 text-[12px] text-text-secondary">
                  {item.label}
                  <span className={`text-[10px] ${item.ok ? 'text-ok' : 'text-danger'}`}>
                    {item.badge}
                  </span>
                </p>
                <p className="mt-0.5 flex items-baseline gap-1">
                  <span
                    className={`tabular font-mono text-[18px] leading-6 ${
                      item.ok ? '' : 'text-danger'
                    }`}
                  >
                    {item.value}
                  </span>
                  <span className="font-mono text-[11px] text-text-tertiary">/ {item.target}</span>
                </p>
              </div>
            ))}
          </div>

          <div className="mt-3 space-y-1 text-[12px]">
            <p className="text-text-secondary">
              证据相关率 {(evalTest.evidenceRate * 100).toFixed(0)}% · 精确率/召回率{' '}
              {(evalTest.precision * 100).toFixed(0)}% / {(evalTest.recall * 100).toFixed(0)}% ·
              误抑制 {evalTest.suppressionErrors} 条
            </p>
            <p className="text-text-secondary">
              {compressionEfficiency !== null
                ? `压缩效率 ${(compressionEfficiency * 100).toFixed(0)}% · `
                : ''}
              {evalTest.handlingUnits !== undefined && evalTest.compressionOnUserLoad !== undefined
                ? `按处理单元 ${evalTest.compressionOnUserLoad.toFixed(1)}:1（${evalTest.handlingUnits} 条，含孤岛 ${
                    evalTest.orphanAlerts ?? 0
                  } 条） · `
                : ''}
              平均 {evalTest.avgDurationMs} ms · P95{' '}
              {evalTest.p95DurationMs ?? evalTest.avgDurationMs} ms
              {evalTest.totalTokens !== undefined
                ? ` · token ${evalTest.totalTokens.toLocaleString()}`
                : ''}
            </p>
            {evalTest.failed.length > 0 ? (
              <p className="text-text-secondary">
                <span className="text-danger">未通过</span>：
                {evalTest.failed.map((f) => `${f.id}「${f.title}」`).join(' · ')}
              </p>
            ) : (
              <p className="text-ok">全部场景通过</p>
            )}
            <p className="text-[11px] text-text-tertiary">
              数据源 <code className="font-mono">evals/results/test.json</code> · 跑于{' '}
              {format(new Date(evalTest.startedAt), 'MM-dd HH:mm')} · 推理模式 {evalTest.mode}
              {' · '}
              {compressionCeiling !== null
                ? `${compressionCeiling.toFixed(1)}:1 是这份数据集的完美聚类上限，不是算法天花板`
                : '压缩比目标按固定 8:1 判定'}
            </p>
          </div>
        </>
      ) : (
        <p className="text-[12px] text-text-tertiary">
          还没有评测产物。执行 <code className="font-mono">npm run eval -- --set=test</code>{' '}
          后这里会显示留出集分数。
        </p>
      )}
    </Card>
  );
}
