import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // dev 与 build 使用独立产物目录：避免 dev 启动时清理生产构建缓存
  distDir: process.env.NODE_ENV === 'development' ? '.next-dev' : '.next',
  // 服务端专用依赖，不打进 bundle
  serverExternalPackages: ['pino', 'pino-pretty', '@prisma/client'],
  eslint: {
    // lint 独立跑（npm run lint），不阻塞 build
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
