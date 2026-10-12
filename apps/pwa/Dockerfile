# syntax=docker/dockerfile:1
# pwa-static — builds the PWA and serves the static app shell via an
# unprivileged nginx. CI builds/pushes ghcr.io/nsoult-agentic/teacher-assistant-pwa:sha-<commit>.
#
# SECURITY: nginx-unprivileged runs as non-root (uid 101) on port 8080; the
# image serves only the built app shell + reference assets. No student data ever
# transits this container — the client holds it encrypted locally.

## ---- build: vite build the PWA (+ its workspace deps) ----
FROM node:22-alpine AS build
RUN npm install -g pnpm@11.17.0
WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --frozen-lockfile
RUN pnpm -r --filter @teacher-assistant/pwa... run build

## ---- runtime: unprivileged nginx serving the static shell ----
FROM nginxinc/nginx-unprivileged:1.30-alpine AS runtime
COPY apps/pwa/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/pwa/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/ >/dev/null 2>&1 || exit 1
