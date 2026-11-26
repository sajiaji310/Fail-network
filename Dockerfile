# NetScope 生产镜像
#
# 三段构建：deps（装依赖）→ builder（next build）→ runner（只带运行所需）。
# 所有页面与 API 路由都是 force-dynamic，构建期不连库，因此 builder 只需要一个
# 占位 DATABASE_URL；真实连接串在运行时由 compose 注入。

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
# postinstall 会跑 prisma generate，所以 schema 必须先就位
COPY prisma ./prisma
RUN npm ci

FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
ENV DATABASE_URL="postgresql://build:build@127.0.0.1:5432/build?schema=public"
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app

# tini 负责转发信号，curl 给 HEALTHCHECK 用
RUN apk add --no-cache tini curl

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    TZ=Asia/Shanghai

# 运行期需要：构建产物 + prisma（migrate deploy）+ scripts（seed）+ src/tsconfig（tsx 跑 seed）
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/src ./src
# 概览页的「评测基线」卡片读这份产物；没有它页面会降级成"尚未跑分"
COPY --from=builder /app/evals/results ./evals/results
COPY --from=builder /app/tsconfig.json ./tsconfig.json
COPY --from=builder /app/next.config.ts ./next.config.ts
COPY --from=builder /app/package.json ./package.json

COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# 不用 root 跑业务进程（node 镜像自带 uid 1000 的 node 用户）
RUN chown -R node:node /app
USER node

EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=3s --start-period=40s --retries=5 \
  CMD curl -fsS http://127.0.0.1:3000/api/health || exit 1

ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/entrypoint.sh"]
