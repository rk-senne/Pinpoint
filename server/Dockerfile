# syntax=docker/dockerfile:1.7
#
# Multi-stage Dockerfile for the FeedbackLoop API server.
#
# Stage 1 (builder): installs the full workspace, builds @feedbackloop/shared
# and @feedbackloop/server, then prunes dev deps.
# Stage 2 (runtime): copies the built artefacts and runs the API.
#
# This image is shared by the `api` and `migrate` services in
# docker-compose.yml; the compose file selects the entrypoint via `command:`.
# Per design key decision #14 (Docker Compose & CI) and Requirement 29.

# ---------- Stage 1: builder ----------
FROM node:20-alpine AS builder

WORKDIR /app

# Copy workspace manifests first to maximise layer caching.
COPY package.json package-lock.json tsconfig.json ./
COPY shared/package.json ./shared/
COPY server/package.json ./server/
COPY dashboard/package.json ./dashboard/
COPY extension/package.json ./extension/

# Install full workspace (incl. dev deps for the TypeScript build).
RUN npm ci --workspaces --include-workspace-root

# Copy the sources we need to build the server slice of the workspace.
COPY shared ./shared
COPY server ./server

# Build shared first (server depends on it via composite project references),
# then the server.
RUN npm run build --workspace @feedbackloop/shared \
 && npm run build --workspace @feedbackloop/server

# ---------- Stage 2: runtime ----------
FROM node:20-alpine AS runtime

ENV NODE_ENV=production

WORKDIR /app

# Workspace manifests, copied first so the npm install layer caches.
COPY package.json package-lock.json ./
COPY shared/package.json ./shared/
COPY server/package.json ./server/
COPY dashboard/package.json ./dashboard/
COPY extension/package.json ./extension/

# Install all workspace dependencies. We need devDependencies on the
# server workspace because `npm run migrate` reads a TypeScript knexfile
# and TypeScript migration files via `ts-node`. Setting NODE_ENV=production
# above would normally omit devDependencies, so we pass `--include=dev`
# explicitly.
RUN npm ci --include=dev \
 && npm cache clean --force

# Copy build outputs from the builder stage.
COPY --from=builder /app/shared/dist ./shared/dist
COPY --from=builder /app/server/dist ./server/dist

# `knex migrate:latest --knexfile knexfile.ts` (run by the `migrate` service)
# loads the TS knexfile and TS migration files at runtime, so we keep the
# server source tree in the image. Used by both the `api` and `migrate`
# compose services.
COPY server/knexfile.ts ./server/knexfile.ts
COPY server/tsconfig.json ./server/tsconfig.json
COPY --from=builder /app/server/src ./server/src

WORKDIR /app/server

EXPOSE 3001

# Default command runs the API. The `migrate` service in docker-compose.yml
# overrides this with `npm run migrate`.
CMD ["node", "dist/index.js"]
