# syntax=docker/dockerfile:1.7
#
# Multi-stage Dockerfile for the FeedbackLoop Dashboard.
#
# Stage 1 (builder): installs the workspace, builds @feedbackloop/shared
# (the dashboard depends on it) and the dashboard's `vite build` bundle.
# Stage 2 (runtime): runs `vite preview` against the built bundle on
# port 4173, exposed to the host per Requirement 29.2.
#
# Per design key decision #14: "dashboard — runs the production
# `vite preview` on the built bundle".

# ---------- Stage 1: builder ----------
FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json tsconfig.json ./
COPY shared/package.json ./shared/
COPY server/package.json ./server/
COPY dashboard/package.json ./dashboard/
COPY extension/package.json ./extension/

RUN npm ci --workspaces --include-workspace-root

COPY shared ./shared
COPY dashboard ./dashboard

RUN npm run build --workspace @feedbackloop/shared \
 && npm run build --workspace @feedbackloop/dashboard

# ---------- Stage 2: runtime ----------
FROM node:20-alpine AS runtime

ENV NODE_ENV=production

WORKDIR /app

COPY package.json package-lock.json ./
COPY shared/package.json ./shared/
COPY server/package.json ./server/
COPY dashboard/package.json ./dashboard/
COPY extension/package.json ./extension/

# Vite is a devDependency on the dashboard workspace, but `vite preview`
# needs it at runtime, so we install with `--include=dev`.
RUN npm ci --include=dev \
 && npm cache clean --force

COPY --from=builder /app/shared/dist ./shared/dist
COPY --from=builder /app/dashboard/dist ./dashboard/dist
COPY dashboard/index.html ./dashboard/index.html
COPY dashboard/vite.config.ts ./dashboard/vite.config.ts
COPY dashboard/tsconfig.json ./dashboard/tsconfig.json

WORKDIR /app/dashboard

# `vite preview` default port. Bind to 0.0.0.0 so the container is
# reachable from the host.
EXPOSE 4173

CMD ["npm", "run", "preview", "--", "--host", "0.0.0.0", "--port", "4173"]
