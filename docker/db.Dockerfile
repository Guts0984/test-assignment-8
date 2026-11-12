# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS build
WORKDIR /repo
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
RUN npm ci --workspace=@helpdesk/shared --workspace=@helpdesk/db --include-workspace-root
COPY packages/shared packages/shared
COPY packages/db packages/db
RUN npm run build -w @helpdesk/shared && npm run build -w @helpdesk/db \
 && npm prune --omit=dev --workspace=@helpdesk/shared --workspace=@helpdesk/db --include-workspace-root

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /repo
COPY --from=build --chown=node:node /repo/node_modules node_modules
COPY --from=build --chown=node:node /repo/packages/shared/package.json packages/shared/package.json
COPY --from=build --chown=node:node /repo/packages/shared/dist packages/shared/dist
COPY --from=build --chown=node:node /repo/packages/db/package.json packages/db/package.json
COPY --from=build --chown=node:node /repo/packages/db/dist packages/db/dist
COPY --from=build --chown=node:node /repo/packages/db/drizzle packages/db/drizzle
USER node
# Applies migrations and seeds an empty database; exits 0 when done (or when already seeded).
CMD ["node", "packages/db/dist/cli.js", "setup"]
