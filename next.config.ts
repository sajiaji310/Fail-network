import type { NextConfig } from 'next';

/**
 * 产物目录。
 *
 * 默认 dev 用 .next-dev、生产用 .next（Docker 与 `npm run start` 都按这个走）。
 * NEXT_DIST_DIR 只是给本地/CI 留的出口：想在已有产物之外再跑一次构建时，
 * 换一个空目录即可，既不用先清空旧产物，也能让 dev 与 build 并行。
 */
const distDir =
  process.env.NEXT_DIST_DIR ?? (process.env.NODE_ENV === 'development' ? '.next-dev' : '.next');

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // dev 与 build 使用独立产物目录：避免 dev 启动时清理生产构建缓存
  distDir,
  // 服务端专用依赖，不打进 bundle
  serverExternalPackages: ['pino', 'pino-pretty', '@prisma/client'],
  eslint: {
    // lint 独立跑（npm run lint），不阻塞 build
    ignoreDuringBuilds: true,
  },
  // 开发指示器会浮在左下角压住侧栏版本号，截图与演示时容易误读
  devIndicators: false,
};

export default nextConfig;
