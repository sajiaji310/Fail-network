import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * E2E ①：概览 → 事件列表 → 事件详情 → 研判 → 采纳 → 结案。
 *
 * 数据准备走 API（幂等、可控），断言全部落在真实渲染的页面上 ——
 * 这样既不会因为"点三次按钮才造出数据"而变脆，也不会漏掉 UI 的回归。
 */

type Simulated = { incidentId: string | null; alertTotal: number };

async function seedIncident(request: APIRequestContext): Promise<{ id: string; code: string }> {
  const res = await request.post('/api/v1/ingest/simulate', {
    data: { scenario: 'core-switch-board-failure', reset: true },
  });
  expect(res.ok(), '注入剧本失败').toBeTruthy();
  const sim = (await res.json()) as Simulated;
  expect(sim.incidentId, '剧本没有产出事件').toBeTruthy();

  const detail = await request.get(`/api/v1/incidents/${sim.incidentId}`);
  expect(detail.ok()).toBeTruthy();
  const body = (await detail.json()) as { id: string; code: string };
  return { id: body.id, code: body.code };
}

/**
 * 点「采纳」并等它真的发出去。
 *
 * dev 模式下首屏要现编译，按钮的 onClick 在 hydration 完成前是空的 ——
 * 直接用 click() 会"点了个寂寞"，测试就变成偶发失败。这里以 PATCH 响应为准，
 * 没发出去就再点一次；点满 4 次还没有响应才判失败。
 */
async function acceptFirstHypothesis(page: Page): Promise<boolean> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const button = page.getByRole('button', { name: '采纳为首要根因' }).first();
    if (!(await button.isVisible().catch(() => false))) return false;

    const response = page
      .waitForResponse(
        (res) => res.url().includes('/hypotheses/') && res.request().method() === 'PATCH',
        { timeout: 5_000 },
      )
      .catch(() => null);

    await button.click();
    const settled = await response;
    if (settled?.ok()) return true;
    await page.waitForTimeout(800);
  }
  return false;
}

/**
 * 点「结案」并等二次确认弹窗真的出现。
 *
 * 和「采纳」同一个原因：reload 之后首屏还在编译，onClick 是空的，点了没反应。
 * 弹窗本身由客户端 state 驱动 —— 它一出现就说明 hydration 已经完成，
 * 所以只需要对"第一次点击"重试，弹窗内部的填写与确认可以放心直点。
 */
async function openResolveDialog(page: Page) {
  const dialog = page.getByRole('dialog');
  const trigger = page.getByRole('button', { name: '结案', exact: true }).first();

  for (let attempt = 0; attempt < 5; attempt++) {
    await trigger.click();
    if (await dialog.isVisible().catch(() => false)) return dialog;
    await page.waitForTimeout(800);
  }
  throw new Error('点「结案」始终没有弹出二次确认');
}

test('概览 → 事件详情 → 研判 → 采纳 → 结案', async ({ page, request }) => {
  const incident = await seedIncident(request);

  await page.goto('/overview');
  await expect(page.getByRole('heading', { name: '概览' })).toBeVisible();

  await page.goto('/incidents');
  await expect(page.getByText(incident.code, { exact: false }).first()).toBeVisible();
  await page
    .getByRole('link', { name: new RegExp(incident.code) })
    .first()
    .click();
  await expect(page).toHaveURL(new RegExp(`/incidents/${incident.id}`));

  // 研判：先走 API 触发，避免依赖按钮位置；页面刷新后断言结论渲染
  const analyzed = await request.post(`/api/v1/incidents/${incident.id}/analyze`, {
    data: { force: true },
  });
  expect(analyzed.ok(), '研判接口失败').toBeTruthy();
  const outcome = (await analyzed.json()) as { source: string; hypotheses: unknown[] };
  expect(outcome.source, '无 key 环境必须降级到规则引擎').toBe('RULE_FALLBACK');
  expect(outcome.hypotheses.length).toBeGreaterThan(0);

  await page.reload();
  await expect(page.getByRole('heading', { name: '根因研判' })).toBeVisible();
  await expect(page.getByText('证据', { exact: false }).first()).toBeVisible();

  // 人工确认：采纳首条假设（hydration 完成前点击无效，helper 里会重试）
  expect(await acceptFirstHypothesis(page), '采纳请求始终没有发出').toBe(true);
  await page.reload();
  await expect(page.getByText('已采纳', { exact: false }).first()).toBeVisible();

  // 结案：二次确认弹窗 + 备注
  const dialog = await openResolveDialog(page);
  await dialog.getByRole('textbox').fill('E2E：更换线卡后恢复，观察 30 分钟无新告警');
  await dialog.getByRole('button', { name: '结案', exact: true }).click();

  await expect(dialog).toBeHidden();
  await expect(page.getByText('MTTR', { exact: false }).first()).toBeVisible();
  await expect(page.getByText('已恢复', { exact: false }).first()).toBeVisible();
  await expect(page.getByText('结案于', { exact: false }).first()).toBeVisible();

  // 结案副作用：报告面板出现四段内容
  await expect(page.getByRole('button', { name: '复盘报告' })).toBeVisible();
  await expect(page.getByText('改进项', { exact: false }).first()).toBeVisible();
});
