#!/bin/sh
# 容器启动序列：应用迁移 → 播种基础数据（幂等）→ 起服务
set -e

echo "[netscope] 应用数据库迁移…"
if ! ./node_modules/.bin/prisma migrate deploy; then
  echo "[netscope] 迁移失败。若数据卷是旧版用 db push 建的（没有 _prisma_migrations 记录），" >&2
  echo "  请执行 docker compose down -v 重建，或按 README「数据库迁移」手动登记基线。" >&2
  exit 1
fi

if [ "${SEED_ON_START:-true}" = "true" ]; then
  echo "[netscope] 播种基础数据（30 设备 / 60 链路 / 30 案例，幂等）…"
  ./node_modules/.bin/tsx scripts/seed.ts
fi

echo "[netscope] 启动 http://0.0.0.0:${PORT:-3000}"
exec npm run start
