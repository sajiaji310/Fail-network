import { PrismaClient } from '@prisma/client';

/**
 * Prisma 单例。dev 下 HMR 会反复执行模块，必须复用同一个实例，
 * 否则连接池会被打爆（详见 13.4 API p95 < 300ms）。
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = db;
}
