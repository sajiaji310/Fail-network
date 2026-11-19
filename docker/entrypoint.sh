#!/bin/sh
# 容器启动序列：同步表结构 → 播种基础数据（幂等）→ 起服务
set -e

echo "[netscope] 同步表结构…"
./node_modules/.bin/prisma db push --skip-generate

if [ "${SEED_ON_START:-true}" = "true" ]; then
  echo "[netscope] 播种基础数据（30 设备 / 60 链路 / 30 案例，幂等）…"
  ./node_modules/.bin/tsx scripts/seed.ts
fi

echo "[netscope] 启动 http://0.0.0.0:${PORT:-3000}"
exec npm run start
