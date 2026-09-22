# OCSO container images (docs/13, research/04 §8). One Dockerfile, four runtime targets:
#
#   api      NestJS control plane (port 4000)        docker build --target api     -t ocso-api .
#   worker   NestJS agent worker (health port 4100)  docker build --target worker  -t ocso-worker .
#   migrate  one-shot schema migrations              docker build --target migrate -t ocso-migrate .
#   web      Next.js standalone BFF (port 3000)      docker build --target web     -t ocso-web .
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
 && test -f /out/api/dist/main.js \
 && test -f /out/api/dist/seed.js \
 && test -f /out/worker/dist/main.js \
 && test -f /out/migrate/dist/bin/migrate.js \
 && test -d /out/migrate/migrations

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
USER node
HEALTHCHECK NONE
CMD ["node", "--enable-source-maps", "dist/bin/migrate.js"]

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
# apps/web has no public/ dir today; create it so the runtime COPY is stable.
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
