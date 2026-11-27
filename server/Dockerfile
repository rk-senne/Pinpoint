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
FROM node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5 AS builder

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
FROM node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5 AS runtime

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
# Runtime data read by shared at runtime (password blocklist).
COPY --from=builder /app/shared/data ./shared/data
COPY --from=builder /app/server/dist ./server/dist
COPY --from=builder /app/widget/dist ./widget/dist

# `knex migrate:latest --knexfile knexfile.ts` (run by the `migrate`
# service) loads the TS knexfile and TS migration files at runtime.
COPY server/knexfile.ts ./server/knexfile.ts
COPY server/scripts/migrate.cjs ./server/scripts/migrate.cjs
# server/tsconfig.json `extends: ../tsconfig.json`; ts-node needs both.
COPY tsconfig.json ./tsconfig.json
COPY server/tsconfig.json ./server/tsconfig.json
COPY server/src/migrations ./server/src/migrations

# Patch base-image OS packages; drop npm/npx/corepack (the runtime only runs
# `node`; npm's bundled dependencies carry their own CVEs).
RUN apk upgrade --no-cache \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack

WORKDIR /app/server

# Local-disk screenshot storage (STORAGE_DRIVER=local, the default when no S3
# is configured). Mount a volume here; the directory is created 0700.
ENV LOCAL_STORAGE_DIR=/data/screenshots
RUN mkdir -p /data/screenshots && chown node:node /data/screenshots && chmod 700 /data/screenshots
VOLUME ["/data/screenshots"]

# The widget bundle path is resolved relative to dist by default; pin it.
ENV WIDGET_DIST_DIR=/app/widget/dist

EXPOSE 3001

# Run as the unprivileged `node` user from the base image (the app needs no
# root: port 3001, read-only code, writes only to /data/screenshots).
USER node

# Default command runs the API. The `migrate` service in docker-compose.yml
# overrides this with `npm run migrate`.
CMD ["node", "dist/index.js"]
