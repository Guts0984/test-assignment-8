# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS build
ARG PNPM_VERSION=12.6.0
RUN npm install -g pnpm@${PNPM_VERSION}
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --filter @helpdesk/api...
COPY packages/shared packages/shared
COPY packages/db packages/db
COPY apps/api apps/api
RUN pnpm --filter @helpdesk/shared build \
 && pnpm --filter @helpdesk/db build \
 && pnpm --filter @helpdesk/api build \
 && pnpm --filter @helpdesk/api deploy --prod /out

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
# /out = the api + its production dependencies only (incl. the built @helpdesk/shared and @helpdesk/db)
COPY --from=build --chown=node:node /out ./
USER node
EXPOSE 3001
CMD ["node", "dist/main.js"]
