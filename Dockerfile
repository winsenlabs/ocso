# OCSO container images (docs/13, research/04 §8). One Dockerfile, four runtime targets:
#
#   api      NestJS control plane (port 4000)        docker build --target api     -t ocso-api .
#   worker   NestJS agent worker (health port 4100)  docker build --target worker  -t ocso-worker .
#   migrate  one-shot schema migrations              docker build --target migrate -t ocso-migrate .
#   web      Next.js standalone BFF (port 3000)      docker build --target web     -t ocso-web .
#   website  public site, Next standalone (port 8080) docker build --target website -t ocso-website .
#
# Pipeline per app group: turbo prune --docker → pnpm install --frozen-lockfile →
# turbo build → pnpm deploy --legacy --prod (server) / Next standalone output (web).
#
# Works with the classic builder: no BuildKit-only syntax (RUN --mount, heredocs).
# The classic builder builds EVERY stage above the requested target, so the server
# stages come first and the web stages last: `--target api|worker|migrate` never
# builds the web app, while `--target web` reuses the cached server layers.
# (BuildKit skips unrelated stages regardless of order.)

ARG NODE_IMAGE=node:26-slim

# ─── toolchain ────────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS toolchain
ENV CI=true \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    TURBO_TELEMETRY_DISABLED=1 \
    NEXT_TELEMETRY_DISABLED=1 \
    DO_NOT_TRACK=1
# Node 26 images ship without corepack: install the pnpm pinned in the root
# packageManager field, and the turbo version the workspace uses.
RUN npm install -g pnpm@11.1.2 turbo@2.11.2 && npm cache clean --force

# ─── server: prune → install → build → deploy ────────────────────────────────
FROM toolchain AS server-prune
WORKDIR /repo
COPY . .
RUN turbo prune @ocso/api @ocso/worker --docker

FROM toolchain AS server-build
WORKDIR /repo
# Manifests + pruned lockfile first so the install layer is cached until a
# dependency actually changes.
COPY --from=server-prune /repo/out/json/ ./
RUN pnpm install --frozen-lockfile
COPY --from=server-prune /repo/out/full/ ./
# turbo prune drops root files that are not package manifests.
COPY tsconfig.base.json ./
RUN turbo run build --filter=@ocso/api... --filter=@ocso/worker...
# Self-contained production trees: dist + prod node_modules (workspace packages
# are copied, limited to each package's `files`). --legacy: pnpm 11 otherwise
# requires injectWorkspacePackages, which would change local dev linking.
RUN pnpm deploy --legacy --filter=@ocso/api --prod /out/api \
 && pnpm deploy --legacy --filter=@ocso/worker --prod /out/worker \
 && pnpm deploy --legacy --filter=@ocso/db --prod /out/migrate \
 && pnpm deploy --legacy --filter=@ocso/audit-store --prod /out/audit-store \
 && test -f /out/api/dist/main.js \
 && test -f /out/api/dist/seed.js \
 && test -f /out/worker/dist/main.js \
 && test -f /out/migrate/dist/bin/migrate.js \
 && test -d /out/migrate/migrations \
 && test -f /out/audit-store/dist/bin/audit-migrate.js \
 && test -f /out/audit-store/dist/bin/audit-verify.js \
 && test -d /out/audit-store/migrations/postgres \
 && test -d /out/audit-store/migrations/clickhouse

# ─── server runtime base (api / worker / migrate) ────────────────────────────
FROM ${NODE_IMAGE} AS server-base
ARG APP_VERSION=dev
ARG RDS_CA_BUNDLE_URL=https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
ENV NODE_ENV=production \
    APP_VERSION=${APP_VERSION} \
    BLOB_LOCAL_DIR=/var/lib/ocso/blobs
LABEL org.opencontainers.image.source="https://github.com/winsenlabs/ocso" \
      org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.licenses="UNLICENSED"
# Amazon RDS CA bundle: RDS certificates are not in Node's bundled CA store, and
# the pg pool verifies certificates when DATABASE_SSL=true. On AWS set
# NODE_EXTRA_CA_CERTS=/etc/ssl/certs/rds-global-bundle.pem (the Terraform task
# definitions do). Unused elsewhere.
ADD ${RDS_CA_BUNDLE_URL} /etc/ssl/certs/rds-global-bundle.pem
COPY infra/compose/ocso-entrypoint.sh /usr/local/bin/ocso-entrypoint
# The local blob directory is owned by the runtime user so a fresh named volume
# mounted there inherits that ownership. Application files stay root-owned
# (read-only for the runtime user).
RUN chmod 0644 /etc/ssl/certs/rds-global-bundle.pem \
 && chmod 0755 /usr/local/bin/ocso-entrypoint \
 && mkdir -p /var/lib/ocso/blobs \
 && chown node:node /var/lib/ocso/blobs
WORKDIR /app
ENTRYPOINT ["/usr/local/bin/ocso-entrypoint"]

# ─── api ─────────────────────────────────────────────────────────────────────
FROM server-base AS api
ENV PORT=4000 OTEL_SERVICE_NAME=ocso-api
COPY --from=server-build /out/api ./
USER node
EXPOSE 4000
# node:26-slim has no curl/wget; Node's fetch keeps the image small.
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=6 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health/ready').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
# --import loads OpenTelemetry before express/pg (research/04 §7). Demo seed:
# `node --enable-source-maps dist/seed.js` in this image.
CMD ["node", "--enable-source-maps", "--import", "./dist/instrumentation.js", "dist/main.js"]

# ─── worker ──────────────────────────────────────────────────────────────────
FROM server-base AS worker
ENV HEALTH_PORT=4100 OTEL_SERVICE_NAME=ocso-worker
COPY --from=server-build /out/worker ./
USER node
EXPOSE 4100
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=6 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.HEALTH_PORT||4100)+'/health/ready').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "--enable-source-maps", "--import", "./dist/instrumentation.js", "dist/main.js"]

# ─── migrate (explicit deployment step, docs/13 §5) ──────────────────────────
FROM server-base AS migrate
# @ocso/db ships dist/ + migrations/; dist/bin/migrate.js resolves ../../migrations.
COPY --from=server-build /out/migrate ./
# The audit store's provisioning and verification tools (ADR-032): audit-migrate
# applies the selected driver's schema and writer role after the main migrations;
# audit-verify re-checks the hash chain (`docker compose run --rm migrate
# node audit-store/dist/bin/audit-verify.js`).
COPY --from=server-build /out/audit-store ./audit-store
USER node
HEALTHCHECK NONE
CMD ["sh", "-c", "node --enable-source-maps dist/bin/migrate.js && node --enable-source-maps audit-store/dist/bin/audit-migrate.js"]

# ─── web: prune → install → build (Next standalone) ──────────────────────────
FROM toolchain AS web-prune
WORKDIR /repo
COPY . .
RUN turbo prune @ocso/web --docker

FROM toolchain AS web-build
WORKDIR /repo
COPY --from=web-prune /repo/out/json/ ./
RUN pnpm install --frozen-lockfile
COPY --from=web-prune /repo/out/full/ ./
COPY tsconfig.base.json ./
# Next resolves rewrite destinations at BUILD time (apps/web/next.config.ts), so
# the image is built for the internal API origin it will run against. Compose
# service name and the ECS Service Connect alias are both `api:4000`.
ARG API_URL=http://api:4000
ENV API_URL=${API_URL}
# Optional: the public origin, so pre-rendered pages link the Open Graph card absolutely.
ARG OCSO_PUBLIC_URL=
ENV OCSO_PUBLIC_URL=${OCSO_PUBLIC_URL}
# apps/web has public/ (web manifest icons); create it so the runtime COPY is stable.
# --env-mode=loose: turbo 2 runs tasks in strict env mode and would strip
# API_URL (not declared in turbo.json), silently baking the localhost fallback
# into the rewrites. The grep fails the build if that ever happens again.
RUN mkdir -p apps/web/public \
 && turbo run build --filter=@ocso/web... --env-mode=loose \
 && test -f apps/web/.next/standalone/apps/web/server.js \
 && grep -q "\"${API_URL}/channels/" apps/web/.next/routes-manifest.json

# ─── web runtime ─────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS web
ARG APP_VERSION=dev
ARG API_URL=http://api:4000
ENV NODE_ENV=production \
    APP_VERSION=${APP_VERSION} \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    API_URL=${API_URL}
LABEL org.opencontainers.image.source="https://github.com/winsenlabs/ocso" \
      org.opencontainers.image.version="${APP_VERSION}"
WORKDIR /app
# Standalone output = server.js + traced node_modules; static assets and public/
# are copied next to it. Root-owned; only the Next cache dir is writable.
COPY --from=web-build /repo/apps/web/.next/standalone ./
COPY --from=web-build /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=web-build /repo/apps/web/public ./apps/web/public
RUN mkdir -p apps/web/.next/cache && chown node:node apps/web/.next/cache
USER node
EXPOSE 3000
# `/` redirects to /login without a session; /login is the cheapest 200.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/login').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "apps/web/server.js"]

# ─── website: the public site, a Next.js standalone server ───────────────────
# Last, so the classic builder never builds it for the other targets. Nothing
# here depends on the product apps: turbo prune keeps only apps/website.
FROM toolchain AS website-build
WORKDIR /repo
COPY . .
RUN turbo prune @ocso/website --docker --out-dir /prune
WORKDIR /site
RUN cp -r /prune/json/. ./ && pnpm install --frozen-lockfile \
 && cp -r /prune/full/. ./ && cp /repo/tsconfig.base.json ./
# Canonical URLs, robots.txt, the sitemap and llms.txt are absolute: build for the domain it is served on.
ARG OCSO_SITE_URL=https://ocso.winsenlabs.dev
ENV OCSO_SITE_URL=${OCSO_SITE_URL}
RUN turbo run build --filter=@ocso/website --env-mode=loose \
 && test -f apps/website/.next/standalone/apps/website/server.js

FROM ${NODE_IMAGE} AS website
ARG APP_VERSION=dev
ARG OCSO_SITE_URL=https://ocso.winsenlabs.dev
# Port 8080, as the Caddy site block for OCSO_WEBSITE_DOMAIN expects (infra/compose/Caddyfile.with-website).
ENV NODE_ENV=production \
    APP_VERSION=${APP_VERSION} \
    OCSO_SITE_URL=${OCSO_SITE_URL} \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=8080
LABEL org.opencontainers.image.source="https://github.com/winsenlabs/ocso" \
      org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.licenses="Apache-2.0"
WORKDIR /app
# Standalone output = server.js + traced node_modules; static assets and public/
# are copied next to it. Root-owned; only the Next cache dir is writable (a
# tmpfs under Compose, where the root filesystem is read-only).
COPY --from=website-build /site/apps/website/.next/standalone ./
COPY --from=website-build /site/apps/website/.next/static ./apps/website/.next/static
COPY --from=website-build /site/apps/website/public ./apps/website/public
RUN mkdir -p apps/website/.next/cache && chown node:node apps/website/.next/cache
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/api/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "apps/website/server.js"]
