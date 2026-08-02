FROM node:22-bookworm-slim AS toolchain
RUN corepack enable && corepack prepare pnpm@11.9.0 --activate
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/gateway/package.json packages/gateway/package.json
COPY packages/control-plane/package.json packages/control-plane/package.json
COPY packages/worker/package.json packages/worker/package.json
COPY services/mock-provider/package.json services/mock-provider/package.json

FROM toolchain AS development-dependencies
RUN pnpm install --frozen-lockfile

FROM development-dependencies AS builder
COPY tsconfig.json ./
COPY packages ./packages
COPY services ./services
RUN pnpm build

FROM toolchain AS production-dependencies
RUN pnpm install --prod --frozen-lockfile

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN groupadd --system tollgate && useradd --system --gid tollgate --home-dir /app tollgate
COPY --from=production-dependencies --chown=tollgate:tollgate /app/package.json ./package.json
COPY --from=production-dependencies --chown=tollgate:tollgate /app/node_modules ./node_modules
COPY --from=production-dependencies --chown=tollgate:tollgate /app/packages ./packages
COPY --from=production-dependencies --chown=tollgate:tollgate /app/services ./services
COPY --from=builder --chown=tollgate:tollgate /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder --chown=tollgate:tollgate /app/packages/db/dist ./packages/db/dist
COPY --from=builder --chown=tollgate:tollgate /app/packages/db/migrations ./packages/db/migrations
COPY --from=builder --chown=tollgate:tollgate /app/packages/gateway/dist ./packages/gateway/dist
COPY --from=builder --chown=tollgate:tollgate /app/packages/control-plane/dist ./packages/control-plane/dist
COPY --from=builder --chown=tollgate:tollgate /app/packages/worker/dist ./packages/worker/dist
COPY --from=builder --chown=tollgate:tollgate /app/services/mock-provider/dist ./services/mock-provider/dist
USER tollgate
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + process.env.PORT + '/health').then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))"]

FROM runtime AS gateway
ENV PORT=3000
CMD ["node", "packages/gateway/dist/server.js"]

FROM runtime AS control-plane
ENV PORT=3001
CMD ["node", "packages/control-plane/dist/server.js"]

FROM runtime AS worker
ENV PORT=3003
CMD ["node", "packages/worker/dist/server.js"]

FROM runtime AS mock-provider
ENV PORT=4010
CMD ["node", "services/mock-provider/dist/server.js"]

FROM runtime AS migrate
HEALTHCHECK NONE
CMD ["node", "packages/db/dist/migrate.js"]
