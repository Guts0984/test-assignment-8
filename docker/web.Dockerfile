# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS build
ARG PNPM_VERSION=12.6.0
# Where the Next server proxies /api/* to. Baked in at build time (it is part of Next's route table).
ARG API_INTERNAL_URL=http://api:3001
ENV API_INTERNAL_URL=${API_INTERNAL_URL} NEXT_TELEMETRY_DISABLED=1
RUN npm install -g pnpm@${PNPM_VERSION}
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter @helpdesk/web...
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN pnpm --filter @helpdesk/shared build && pnpm --filter @helpdesk/web build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
# Next's "standalone" output: a minimal server with only the dependencies it traces
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
