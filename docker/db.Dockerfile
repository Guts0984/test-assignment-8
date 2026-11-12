# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS build
ARG PNPM_VERSION=12.6.0
RUN npm install -g pnpm@${PNPM_VERSION}
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
RUN pnpm install --frozen-lockfile --filter @helpdesk/db...
COPY packages/shared packages/shared
COPY packages/db packages/db
RUN pnpm --filter @helpdesk/shared build && pnpm --filter @helpdesk/db build \
 && pnpm --filter @helpdesk/db deploy --prod /out

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
# /out = the db package + its production dependencies only (incl. built @helpdesk/shared)
COPY --from=build --chown=node:node /out ./
USER node
# Applies migrations and seeds an empty database; exits 0 when done (or when already seeded).
CMD ["node", "dist/cli.js", "setup"]
