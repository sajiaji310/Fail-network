import { defineConfig } from '@playwright/test';

/**
 * E2E 配置（文档 15 节）：
 * 两条主流程 + 截图脚本共用同一份配置。
 *
 * `channel: 'chrome'` 而不是下载 Playwright 自带的 Chromium：
 * 本机已有 Chrome/Edge，省掉 120MB 下载，CI 里换成默认 chromium 即可。
 */
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:3000',
    channel: 'chrome',
    headless: true,
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN',
    screenshot: 'only-on-failure',
    trace: 'off',
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://127.0.0.1:3000/api/health',
    reuseExistingServer: true,
    timeout: 180_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
