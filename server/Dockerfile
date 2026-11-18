# syntax=docker/dockerfile:1.7
#
# Multi-stage Dockerfile for the Pinpoint API server.
#
# Stage 1 (builder): installs the workspace and compiles @pinpoint/shared,
# @pinpoint/server, and the embeddable @pinpoint/widget bundle (the API
# serves it at GET /widget/pinpoint-widget.js).
# Stage 2 (runtime): production dependencies + compiled output. This image
# is shared by the `api` and `migrate` services in docker-compose.yml.

# ---------- Stage 1: builder ----------
FROM node:20-alpine AS builder

WORKDIR /app

# Every workspace manifest must be present for `npm ci` to resolve the
# lockfile's workspace graph.
COPY package.json package-lock.json tsconfig.json ./
COPY shared/package.json ./shared/
COPY server/package.json ./server/
COPY dashboard/package.json ./dashboard/
COPY extension/package.json ./extension/
COPY e2e/package.json ./e2e/
COPY mobile-sdk/package.json ./mobile-sdk/
COPY mcp-server/package.json ./mcp-server/
COPY widget/package.json ./widget/

RUN npm ci --workspace @pinpoint/shared --workspace @pinpoint/server --workspace @pinpoint/widget --include-workspace-root

COPY shared ./shared
COPY server ./server
COPY widget ./widget

RUN npm run build --workspace @pinpoint/shared \
 && npm run build --workspace @pinpoint/server \
 && npm run build --workspace @pinpoint/widget

# ---------- Stage 2: runtime ----------
FROM node:20-alpine AS runtime

ENV NODE_ENV=production

WORKDIR /app

COPY package.json package-lock.json ./
COPY shared/package.json ./shared/
COPY server/package.json ./server/
COPY dashboard/package.json ./dashboard/
COPY extension/package.json ./extension/
COPY e2e/package.json ./e2e/
COPY mobile-sdk/package.json ./mobile-sdk/
COPY mcp-server/package.json ./mcp-server/
COPY widget/package.json ./widget/

# Production deps for the server only. `knex migrate` loads the TypeScript
# knexfile and migrations through ts-node, which lives in the server's
# devDependencies — so the `migrate` service needs dev deps too. Install
# them once here so one image serves both `api` and `migrate`.
RUN npm ci --workspace @pinpoint/shared --workspace @pinpoint/server --include-workspace-root --include=dev \
 && npm cache clean --force

COPY --from=builder /app/shared/dist ./shared/dist
COPY --from=builder /app/server/dist ./server/dist
COPY --from=builder /app/widget/dist ./widget/dist

# `knex migrate:latest --knexfile knexfile.ts` (run by the `migrate`
# service) loads the TS knexfile and TS migration files at runtime.
COPY server/knexfile.ts ./server/knexfile.ts
# server/tsconfig.json `extends: ../tsconfig.json`; ts-node needs both.
COPY tsconfig.json ./tsconfig.json
COPY server/tsconfig.json ./server/tsconfig.json
COPY server/src/migrations ./server/src/migrations

WORKDIR /app/server

# The widget bundle path is resolved relative to dist by default; pin it.
ENV WIDGET_DIST_DIR=/app/widget/dist

EXPOSE 3001

# Default command runs the API. The `migrate` service in docker-compose.yml
# overrides this with `npm run migrate`.
CMD ["node", "dist/index.js"]
