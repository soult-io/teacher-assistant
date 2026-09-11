# syntax=docker/dockerfile:1
# sync-relay — multi-stage build. CI (ci.yml) builds and pushes
# ghcr.io/nsoult-agentic/teacher-assistant-sync-relaye stack).

## ---- build: install workspace deps, build this service + its workspace deps ----
FROM node:22-alpine AS build
RUN npm install -g pnpm@11.17.0
WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages ./packages
COPY services ./services
RUN pnpm install --frozen-lockfile
RUN pnpm -r --filter @teacher-assistant/sync-relay... run build
# Self-contained prod deploy (workspace:* deps resolved + inlined).
RUN pnpm deploy --legacy --filter @teacher-assistant/sync-relay --prod /prod/app

## ---- runtime: node:22-alpine, non-root, healthcheck on /health ----
FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    PORT=8931 \
    SECRETS_DIR=/run/secrets
WORKDIR /app
# Strip package managers from the runtime image (smaller surface; the app runs
# `node` directly).
RUN rm -rf /usr/local/lib/node_modules/npm \
           /usr/local/lib/node_modules/corepack \
           /opt/yarn-v* \
           /usr/local/bin/npm /usr/local/bin/npx \
           /usr/local/bin/yarn /usr/local/bin/yarnpkg \
           /usr/local/bin/corepack
# Fixed uid/gid (10001) so the host can own the bind-mounted secret files that
# this non-root user must read (0600, chown 10001:10001).
RUN addgroup -g 10001 -S ta && adduser -u 10001 -S -G ta ta
COPY --from=build --chown=ta:ta /prod/app ./
USER ta
EXPOSE 8931
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8931/health || exit 1
CMD ["node", "dist/index.js"]
