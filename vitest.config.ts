import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// 测试进程继承 .env（Prisma 需要 DATABASE_URL）
try {
  process.loadEnvFile('.env');
} catch {
  // CI 用环境变量注入
}

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}', 'evals/**/*.test.ts', 'tests/unit/**/*.test.ts'],
    exclude: ['node_modules', '.next', '.next-dev'],
    reporters: 'default',
    // DB 集成用例串行跑，避免并发抢唯一键
    fileParallelism: false,
  },
});
