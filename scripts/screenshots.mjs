/**
 * README 截图生成器。
 *
 * 不手摆数据：直接调 /api/v1/ingest/simulate 注入一套剧本，再跑一次研判，
 * 让截图里的告警、事件、结论都是系统真实算出来的 —— README 里的图不会和
 * 代码行为脱节。
 *
 * 用法：node scripts/screenshots.mjs
 * 前置：dev server 或生产 server 已在 APP_BASE_URL（默认 3000）上跑着。
 */
import { mkdir } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const BASE = process.env.APP_BASE_URL ?? 'http://127.0.0.1:3000';
const OUT = 'docs/screenshots';

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

/** 等页面真的画完：主标题出现 + 给动画留一拍（dev 模式首屏现编译，超时给足） */
async function settle(page, heading) {
  if (heading) {
    await page
      .getByRole('heading', { name: heading, exact: true })
      .first()
      .waitFor({ timeout: 90_000 });
  }
  await page.waitForTimeout(800);
}

async function shot(page, name) {
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false });
  console.log(`  ✓ ${OUT}/${name}.png`);
}

await mkdir(OUT, { recursive: true });

console.log(`→ 注入剧本（${BASE}）`);
const sim = await post('/api/v1/ingest/simulate', {
  scenario: 'core-switch-board-failure',
  reset: true,
});
if (!sim.incidentId) throw new Error('剧本没有产出事件，无法截图');
console.log(`  事件 ${sim.incidentId}，告警 ${sim.alertTotal} 条`);

console.log('→ 触发研判');
await post(`/api/v1/incidents/${sim.incidentId}/analyze`, { force: true });

const browser = await chromium.launch({ channel: 'chrome' });
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
  locale: 'zh-CN',
  timezoneId: 'Asia/Shanghai',
});
const page = await context.newPage();

try {
  console.log('→ 截图');
  await page.goto(`${BASE}/overview`, { waitUntil: 'domcontentloaded' });
  await settle(page, '概览');
  await shot(page, 'overview');

  // 概览比一屏高，「评测基线」卡片会被裁在底边 —— 单独截这张卡，README 用它做分数证据
  const evalCard = page
    .getByRole('heading', { name: '评测基线' })
    .locator('xpath=ancestor::section[1]');
  await evalCard.scrollIntoViewIfNeeded();
  await evalCard.screenshot({ path: `${OUT}/eval-baseline.png` });
  console.log(`  ✓ ${OUT}/eval-baseline.png`);

  // 列表截「全部」标签：活跃标签在刚 reset 完只有一条，看不出列表形态
  await page.goto(`${BASE}/incidents?status=all`, { waitUntil: 'domcontentloaded' });
  await settle(page, '事件');
  await shot(page, 'incidents');

  await page.goto(`${BASE}/incidents/${sim.incidentId}`, { waitUntil: 'domcontentloaded' });
  await settle(page, '根因研判');
  await shot(page, 'incident-detail');

  await page.goto(`${BASE}/topology`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.react-flow__node', { timeout: 30_000 });
  await page.waitForTimeout(1200); // 等布局动画收尾
  await shot(page, 'topology');

  await page.goto(`${BASE}/cases`, { waitUntil: 'domcontentloaded' });
  await settle(page, '案例库');
  await shot(page, 'cases');
} finally {
  await browser.close();
}

console.log('完成');
