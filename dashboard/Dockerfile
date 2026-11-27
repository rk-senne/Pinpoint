# syntax=docker/dockerfile:1.7
#
# Multi-stage Dockerfile for the Pinpoint Dashboard.
#
# Stage 1 (builder): installs the workspace, builds @pinpoint/shared (the
# dashboard depends on it) and the dashboard's `vite build` bundle.
# Stage 2 (runtime): runs `vite preview` against the built bundle on port
# 4173. `vite preview` also proxies /api, /socket.io, /widget and review-link
# frames to the API (API_PROXY_TARGET), so the dashboard and API share one
# origin — see dashboard/vite.config.ts.

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

RUN npm ci --workspace @pinpoint/shared --workspace @pinpoint/dashboard --include-workspace-root

COPY shared ./shared
COPY dashboard ./dashboard

RUN npm run build --workspace @pinpoint/shared \
 && npm run build --workspace @pinpoint/dashboard

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

# Vite is a devDependency, but `vite preview` needs it at runtime.
RUN npm ci --workspace @pinpoint/shared --workspace @pinpoint/dashboard --include-workspace-root --include=dev \
 && npm cache clean --force

COPY --from=builder /app/shared/dist ./shared/dist
COPY --from=builder /app/dashboard/dist ./dashboard/dist
COPY dashboard/index.html ./dashboard/index.html
COPY dashboard/vite.config.ts ./dashboard/vite.config.ts
COPY dashboard/tsconfig.json ./dashboard/tsconfig.json

WORKDIR /app/dashboard

EXPOSE 4173

CMD ["npm", "run", "preview", "--", "--host", "0.0.0.0", "--port", "4173"]
