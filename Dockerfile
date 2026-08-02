FROM node:22-bookworm-slim AS base
RUN corepack enable && corepack prepare pnpm@11.9.0 --activate
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY tsconfig.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/gateway/package.json packages/gateway/package.json
COPY packages/control-plane/package.json packages/control-plane/package.json
COPY packages/worker/package.json packages/worker/package.json
COPY services/mock-provider/package.json services/mock-provider/package.json
RUN pnpm install --frozen-lockfile=false
COPY packages ./packages
COPY services ./services

FROM base AS gateway
CMD ["pnpm", "--filter", "@tollgate/gateway", "start"]

FROM base AS control-plane
CMD ["pnpm", "--filter", "@tollgate/control-plane", "start"]

FROM base AS worker
CMD ["pnpm", "--filter", "@tollgate/worker", "start"]

FROM base AS mock-provider
CMD ["pnpm", "--filter", "@tollgate/mock-provider", "start"]
