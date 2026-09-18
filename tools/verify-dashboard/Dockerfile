# syntax=docker/dockerfile:1
# teacher-assistant-verify — serves the pre-generated static TRACK Verification
# dashboard (index.html + videos/ + traces/) via an unprivileged nginx. The dashboard is
# produced by the verification-dashboard workflow's generator (tools/verify-dashboard);
# this image only serves that static output — no app code, no data, PII-free/synthetic,
# same as the app images. CI builds/pushes ghcr.io/<owner>/teacher-assistant-verify:sha-<commit>.
#
# There is no build stage: the workflow generates dist-dashboard/ (in the Playwright
# container) and hands it to this image via the build context; the image just copies it.
#
# SECURITY: nginx-unprivileged runs as non-root (uid 101) on port 8080. Public exposure,
# TLS, and the access gate are the Lexington NPM's job (mirrors the pwa-static image);
# this server is reached by the proxy over the shared docker network.
FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime
COPY tools/verify-dashboard/nginx.conf /etc/nginx/conf.d/default.conf
COPY dist-dashboard /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/ >/dev/null 2>&1 || exit 1
