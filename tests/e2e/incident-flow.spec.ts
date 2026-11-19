import { expect, test, type Page } from '@playwright/test';

/**
 * E2E ②：注入剧本 → 事件生成 → 复盘报告导出。
 *
 * 与 ① 的区别：① 走"接手已有事件"的路径，这里走"从零注入一套故障"的路径，
 * 并验证报告能作为文件导出 —— 报告的实际用途就是贴进周报/群消息。
 */

/**
 * 点「下载 .md」并等下载真的开始。
 *
 * 报告正文是 RSC 渲染的，`<pre>` 里的文字不依赖 JS 就能看到；
 * 但下载按钮的 onClick 要等 hydration 完成才挂上。dev 模式首屏现编译，
 * 直接点会"点了个寂寞"。这里以 download 事件为准重试，4 次都没有才判失败。
 */
async function downloadReport(page: Page) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const event = page.waitForEvent('download', { timeout: 5_000 }).catch(() => null);
    await page.getByRole('button', { name: /下载 \.md/ }).click();
    const download = await event;
    if (download) return download;
    await page.waitForTimeout(800);
  }
  throw new Error('点击「下载 .md」始终没有触发下载事件');
}

test('剧本注入 → 事件生成 → 报告下载', async ({ page, request }) => {
  const res = await request.post('/api/v1/ingest/simulate', {
    data: { scenario: 'routing-policy-change', reset: true },
  });
  expect(res.ok(), '注入 routing-policy-change 失败').toBeTruthy();
  const sim = (await res.json()) as {
    incidentId: string | null;
    alertTotal: number;
    correlation: { created: number };
  };
  expect(sim.incidentId, '剧本没有产出事件').toBeTruthy();
  expect(sim.alertTotal).toBeGreaterThanOrEqual(3);

  // 事件列表能看到刚注入的事件
  await page.goto('/incidents');
  const card = page.locator(`a[href*="${sim.incidentId}"]`).first();
  await expect(card).toBeVisible();
  await card.click();

  // 研判 → 结案（结案才会生成报告快照）
  const id = sim.incidentId!;
  expect(
    (await request.post(`/api/v1/incidents/${id}/analyze`, { data: { force: true } })).ok(),
  ).toBeTruthy();
  expect(
    (
      await request.patch(`/api/v1/incidents/${id}`, {
        data: { status: 'RESOLVED', note: 'E2E 结案' },
      })
    ).ok(),
  ).toBeTruthy();

  await page.reload();
  await expect(page.getByRole('button', { name: '复盘报告' })).toBeVisible();

  // 报告内容：四段齐全
  const report = page.locator('pre');
  await expect(report).toContainText('MTTR');
  await expect(report).toContainText('影响面');
  await expect(report).toContainText('根因');
  await expect(report).toContainText('改进项');

  // 导出 .md
  const download = await downloadReport(page);
  expect(download.suggestedFilename()).toMatch(/\.md$/);

  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const content = Buffer.concat(chunks).toString('utf8');
  expect(content).toContain('复盘报告');
  expect(content).toContain('MTTR');
  expect(content.length).toBeGreaterThan(200);
});
