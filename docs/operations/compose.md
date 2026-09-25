# Running OCSO with Docker Compose

Single-host deployment (docs/13 §2): one machine — a VM or server you run, in any cloud or on
premises — running every OCSO process in containers. The same images run on ECS Fargate
([aws.md](aws.md)); only configuration differs.

| Service | What it does | Published |
|---|---|---|
| `keygen` | One-shot. Creates missing secrets on the `secrets` volume, then exits | – |
| `postgres` | PostgreSQL 18, data on the `pgdata` volume | – |
| `audit-db` | PostgreSQL 18 for the audit store (ADR-032), data on the `auditdata` volume | – |
| `migrate` | One-shot. Applies `packages/db/migrations`, then provisions the audit store (`audit-migrate`), then exits 0 | – |
| `api` | NestJS control plane, port 4000 | – (internal) |
| `worker` | Agent workers, health on 4100. Two replicas by default (`OCSO_WORKER_REPLICAS`). The leader also runs the audit tasks (ship, reconcile, seal, export, full verify; section 10), the weekly exception report, storage sampling and health roll-ups | – |
| `web` | Next.js UI and BFF. Proxies `/channels`, `/public`, `/oauth`, `/.well-known`, `/blobs` to the API | **3000** |

Profiles: `demo` (example MCP server and seed), `observability` (OTel Collector and Jaeger), and
`s3` (SeaweedFS instead of the local blob volume). Overlay files: `infra/compose/tls.yaml` (HTTPS with
Caddy, see [HTTPS](#https-with-the-bundled-caddy-overlay)), `infra/compose/website.yaml` (the public
website, see [Public website](#public-website)) and `infra/compose/debug.yaml` (API and
PostgreSQL on 127.0.0.1).

Only port 3000 is published (with the TLS overlay, Caddy publishes 80 and 443 instead and port 3000
stays on 127.0.0.1). The staff API (`/v1/*`) is not reachable from outside: the browser talks
to Next.js, and Next.js calls the API over the internal network (ADR-020). PostgreSQL sits on an
`internal` network with no outbound internet.

## 1. Prerequisites

- Docker Engine 26+ with Compose v2.30+. Named-volume `subpath` mounts need these versions; this repo
  was verified on Engine 29.2 with Compose 5.1.
- 4 vCPU and 8 GB RAM are enough for a pilot. The image builds take about 3 GB of disk; data grows
  with conversations and media.
- To build: the repository checkout. The build works with the classic builder, and BuildKit/buildx
  is optional. To deploy prebuilt images you only need `compose.yaml`, `infra/compose/`, and `.env`.
- For anything beyond localhost, TLS in front of port 3000, with `OCSO_PUBLIC_URL` set to the public
  `https://` origin: the bundled Caddy overlay ([HTTPS](#https-with-the-bundled-caddy-overlay)), or
  your own reverse proxy (nginx, a load balancer).

## 2. First run

```bash
cp .env.example .env          # set EMAIL_* first (section 9); the rest has safe defaults
docker compose up -d --build  # keygen → postgres + audit-db → migrate → api + worker → web
docker compose ps             # api, worker, web become "healthy"; keygen and migrate "exited (0)"
```

### HTTPS with the bundled Caddy overlay

`infra/compose/tls.yaml` adds a Caddy container that obtains and renews a Let's Encrypt certificate
automatically (HTTP-01 on port 80, TLS-ALPN on 443), redirects http to https, and proxies to the web
app without buffering server-sent events (`infra/compose/Caddyfile`). You need a DNS `A`/`AAAA` record
for your domain pointing at the host, and ports 80 and 443 open to the internet. Set in `.env`:

```dotenv
OCSO_DOMAIN=ocso.example.com
OCSO_PUBLIC_URL=https://ocso.example.com
# Keep the web port off the public interface: Docker's published ports bypass host firewalls such as ufw.
OCSO_HTTP_BIND=127.0.0.1
# Caddy appends the client address to X-Forwarded-For; sign-in rate limits and audit use that hop.
OCSO_TRUSTED_PROXY_HOPS=1
```

```bash
docker compose -f compose.yaml -f infra/compose/tls.yaml up -d --build
```

Pass the same two `-f` files to every later `docker compose` command (or set
`COMPOSE_FILE=compose.yaml:infra/compose/tls.yaml` in `.env`). Certificates live on the `caddy_data`
volume; no account email is needed. Channel webhooks and the web chat widget use `OCSO_PUBLIC_URL`,
so set it before creating channels. With your own reverse proxy instead, apply the same
`OCSO_PUBLIC_URL`, `OCSO_HTTP_BIND` and `OCSO_TRUSTED_PROXY_HOPS` rules (one hop per proxy that appends
`X-Forwarded-For`).

### Public website

`infra/compose/website.yaml` adds the public OCSO website (`apps/website`, a static export) to the
same Compose project. The `website` service is the Dockerfile's `website` target: a small Caddy file
server on port 8080 inside the network, non-root, read-only, with no published port. The overlay
also makes the TLS overlay's Caddy serve a second site, `OCSO_WEBSITE_DOMAIN`, by proxying to
`website:8080` with the same security headers (`infra/compose/Caddyfile.with-website`, which imports the
unchanged `infra/compose/Caddyfile`). Without the overlay nothing changes.

1. Point a DNS `A` (and `AAAA`, if the host has IPv6) record for the website domain at the same host.
2. Set in `.env`:

   ```dotenv
   OCSO_WEBSITE_DOMAIN=ocso.example.com
   # Canonical URLs, robots.txt and the sitemap are built in; default https://ocso.winsenlabs.dev
   OCSO_SITE_URL=https://ocso.example.com
   ```

3. Add the overlay after the TLS one, here and in every later command (or append it to `COMPOSE_FILE`):

   ```bash
   docker compose -f compose.yaml -f infra/compose/tls.yaml -f infra/compose/website.yaml up -d --build
   ```

Caddy obtains the website's certificate the same way as the product's.

**Configure email before inviting anyone.** Invites, password resets and sign-in codes go out by email
(section 9). A first `docker compose up` starts without it so you can try OCSO: messages then only reach
the api/worker log, and Settings → Email shows a warning. For a real deployment set `EMAIL_DRIVER=resend`
(or `smtp`); set `EMAIL_ALLOW_LOG_IN_PRODUCTION=false` to make a missing email configuration a start-up
error.

**Key generation.** Secrets are never in `compose.yaml`, `.env`, or git. On first start the `keygen`
one-shot writes each missing secret to the `secrets` named volume:

| File on the `secrets` volume | Used for |
|---|---|
| `postgres/db_password` (root, 0400) | PostgreSQL password |
| `app/database_url` | `postgres://ocso:<password>@postgres:5432/ocso` |
| `app/master_key` | SecretStore key-encryption key (ADR-012). Losing it loses every stored credential |
| `app/blob_signing_key` | HMAC for signed blob URLs |
| `app/setup_token` | One-time `/setup` token |
| `app/better_auth_secret` | Better Auth secret (ADR-025): signs session cookies, encrypts authenticator secrets and backup codes. Rotating it signs everyone out and users re-enrol their authenticator apps |
| `app/demo_mcp_token`, `demo/*` | Demo MCP bearer token (`demo` profile) |
| `app/aws_credentials`, `seaweedfs/s3.json` | SeaweedFS S3 identity (`s3` profile; readable by SeaweedFS uid 1000 only) |
| `audit-postgres/db_password` (root, 0400) | Audit store database owner password (`audit-db`) |
| `audit-migrate/audit_owner_url`, `audit_writer_password`, `audit_reader_password`, `audit_writer_url`, `audit_reader_url` | Audit store owner connection and the two roles' credentials — mounted only into `migrate` |
| `audit-writer/audit_database_url` | `postgres://ocso_audit_writer:<password>@audit-db:5432/ocso_audit` — INSERT/SELECT only; mounted only into the worker |
| `app/audit_reader_url` | `postgres://ocso_audit_reader:<password>@audit-db:5432/ocso_audit` — SELECT only; what the api (and the demo seed) read with |
| `app/audit_signing_key` | Ed25519 private key (PKCS#8 PEM) signing audit checkpoints, exports and exception reports. Back it up; the public half is at `GET /v1/audit/keys` |

Existing files are never overwritten. Each container mounts only its own sub-directory, so the
postgres container never sees the master key. The images resolve `*_FILE` variables at start-up
(`infra/compose/ocso-entrypoint.sh`); the master key is read as a file by the app and never enters
the environment.

**Create the first Tech admin.** Open `http://localhost:3000`. You are sent to `/setup`. Get the
one-time token with:

```bash
docker compose logs api | grep "setup token"
# or: docker compose exec api cat /run/secrets/ocso/setup_token
```

After setup the token no longer works: `/setup` refuses once a user exists.

Configuration changes need a second person's approval (maker–checker, ADR-030). While the first Tech
admin is the only one who can check, they approve their own platform changes and new users as recorded
*bootstrap* approvals, which are listed in the exception report. Invite a Head (and a second Tech admin)
early; bootstrap stops once another eligible checker exists ([setup guide](setup-guide.md)).

**Sign-in and sessions (ADR-025).** The API sets the session cookie on the public origin (`/api/auth/*`
is forwarded by the web app), so these are **api** settings:

| Variable | Default | Meaning |
|---|---|---|
| `SESSION_COOKIE_SECURE` | `true` | `Secure` + `__Secure-` prefix. Browsers accept it on `http://localhost`; set `false` only for a plain-http trial on another host |
| `SESSION_IDLE_MINUTES` / `SESSION_ABSOLUTE_HOURS` | `120` / `24` | Idle and absolute session lifetime |
| `BETTER_AUTH_SECRET` | keygen file | Override only to share one value across hosts |
| `OCSO_AUTH_TRUSTED_ORIGINS` | empty | Extra origins Better Auth trusts, e.g. an OIDC IdP on a private network |
| `OCSO_RECOVERY_TOKEN` / `_FILE` | unset | Break-glass `/recover` for a locked-out Tech admin (setup guide §1). Set, use once, remove |
| `OCSO_TRUSTED_PROXY_HOPS` (web) | `0` | Reverse proxies in front of web; the client address used for sign-in rate limits comes from this hop |

Upgrading from a release before ADR-025 applies migrations 0014/0015: passwords keep working, every
user signs in once more (old sessions cannot be carried over), and emails are stored in lower case.

**Or seed the Meridian Bank demo** (only on a fresh database):

```bash
OCSO_DEMO_SEED=true docker compose --profile demo up -d --build
docker compose logs seed      # prints the logins
```

This creates:
- **Organization.** Meridian Bank, `ap-south-1`, `Asia/Kolkata`, residency `IN`.
- **Users.** Tech Tarun Shetty, Heads Anjali Rao (Cards & EMI, Hardship) and Rohan Kapoor
  (Sales), Service members Nikhil Menon and Meera Pillai.
  Emails are `@meridian.example`. The password for all of them is `OCSO_DEMO_PASSWORD`, which
  defaults to `meridian-demo-2026`.
- **Teams.** Three teams.
- **Queues.** Four queues with SLA policies.
- **Models.** The development-only scripted model provider, plus the profiles `support-primary`,
  `support-fast`, `sales-primary` and `summarizer`.
- **Agents.** Maya, Arjun and Riya, with curated prompt versions and escalation rules, all LIVE.
  Agents are owned by teams (ADR-026): Maya → Cards & EMI and Riya → Hardship (managed by Anjali),
  Arjun → Sales (managed by Rohan); each Head sees only their teams' agents.
- **Channels.** A web chat channel, reaching the agents through a router and queues.
- **MCP.** The demo MCP server `meridian-core`, discovered, authenticated, classified and approved
  for Maya, with `payments.reverse_transaction` above ₹5,000 requiring confirmation.
- **Alerts.** The default alert rules.

Everything is created through the application services, so it appears in the audit log. Everything
that needs approval goes through it: each demo Head checks the other Head's agents, queues and SLA
policies. The seed is idempotent: later runs exit immediately.

`OCSO_DEMO_SEED=true` also enables the scripted model provider (ADR-015) for api, worker and seed.
Never use it for a real deployment.

## 3. Everyday operations

```bash
docker compose ps                         # state and health
docker compose logs -f api worker         # JSON logs (pino); rotated at 10 MB × 5 per container
docker compose up -d --scale worker=3     # more agent capacity now (docs/10); set OCSO_WORKER_REPLICAS to keep it
docker compose restart worker             # graceful: 90 s to finish or checkpoint turns
docker compose down                       # stop (volumes kept)
```

**Scaling workers.** Workers hold conversation leases in PostgreSQL. Any worker can take over a
conversation whose lease expired, so scaling up or down never loses a conversation (docs/10 §9).
The Tech worker settings (min/max workers, target utilization) are advisory under Compose
(`DEPLOYMENT_DRIVER=compose`): you choose the replica count with `OCSO_WORKER_REPLICAS` in `.env`
(default 2, so one worker can fail without a gap). `--scale worker=N` changes it until the next
`docker compose up -d`. The worker settings page shows the exact
`--scale worker=N` command for the warm floor (see [worker-scaling.md](worker-scaling.md)). Size `DATABASE_POOL_SIZE` × (api + all
workers) below PostgreSQL's `max_connections` (100 by default).

**Health endpoints.**
- api: `/health/live`, `/health/ready` (database) and `/health/dependencies` (Tech admin token required), on the internal
  network.
- worker: `/health/ready` on port 4100.
- web: `/login`.

Container health checks use them. `docker inspect --format '{{json .State.Health}}' ocso-api-1`
shows the recent results.

**Direct API access for debugging.** The debug overlay publishes the API and PostgreSQL on
127.0.0.1 only:

```bash
docker compose -f compose.yaml -f infra/compose/debug.yaml up -d
curl -s -X POST localhost:4000/v1/auth/login -H 'content-type: application/json' \
  -d '{"email":"anjali.rao@meridian.example","password":"meridian-demo-2026"}'
psql "postgres://ocso:$(docker compose exec -T postgres cat /run/secrets/ocso-db/db_password)@127.0.0.1:15433/ocso"
```

## 4. Upgrades and migrations

Migrations are an explicit deployment step (docs/13 §5). The `migrate` one-shot runs before api and
worker start, and they wait for it to exit 0. The runner takes an advisory lock, applies each file in
its own transaction, and refuses to run if an already-applied file was edited (ADR-004).

```bash
git pull                                   # or: set OCSO_VERSION to the new tag and `docker compose pull`
docker compose build                       # skip when pulling prebuilt images
docker compose run --rm migrate            # apply migrations; stop here if it fails
docker compose up -d                       # recreate api / worker / web on the new images
```

Before an upgrade, take a backup (section 5).

`docker compose run --rm migrate` runs both steps: the main migrations (`dist/bin/migrate.js`), then
`audit-migrate` (`audit-store/dist/bin/audit-migrate.js`), which provisions the audit store. `docker
compose up -d` runs the same `migrate` service before api and worker start.

### Upgrading to the governance and routing release

This release adds role presets, per-user permissions, maker–checker approvals, routers and a separate
audit store (ADR-029 to ADR-033). On an existing deployment:

**This release is one-way.** It is an exception to the expand/contract rule below: migration 0021
renames the stored roles, and the previous release cannot read the new names, so the previous image
fails on every authenticated request once 0021 has run. Rolling back past this release means
restoring the pre-upgrade backup, not redeploying the old image. A backup taken right before the
upgrade is therefore required, not optional.

1. **Back up first** (section 5): PostgreSQL and the `secrets` volume. This is the only way back.
   There are no down-migrations, and the previous image does not work against the migrated schema.
   The audit database (`auditdata`) does not exist yet; it is created by this release.
2. **Create the new secrets and start the audit database.** `docker compose up -d keygen audit-db`.
   Keygen adds only the missing files (the `audit-postgres/`, `audit-migrate/` and `audit-writer/`
   credentials, `app/audit_reader_url` and `app/audit_signing_key`) and never touches existing ones.
   Back up the `secrets` volume again afterwards, since it now holds the audit signing key.
3. **Stop the old application, then migrate:** `docker compose stop api worker web`, then
   `docker compose run --rm migrate`. While `run --rm migrate` runs, an old api that is still up
   serves against the migrated schema and returns errors to signed-in users until step 4 replaces it.
   Stopping api, worker and web first avoids that; if you skip it, accept a brief window of errors
   (the length of the migration plus the restart). `docker compose up -d --build` has the same window,
   because Compose recreates api and worker only after `migrate` exits. The main migrations run first
   (0021–0031), then `audit-migrate` creates the audit schema, the `ocso_audit_writer` and
   `ocso_audit_reader` roles and the minimum retention (`AUDIT_MIN_RETENTION_DAYS`, default 365). If it
   fails, fix the cause and run it again; both steps are idempotent.
4. **Start the stack:** `docker compose up -d`.

What changes for people:

- **Roles are mapped automatically** (migration 0021): Platform Tech Admin → Tech, CS Lead → Head,
  CS Exec → Service. Role lists stored as data (alert audiences, tool human roles, MFA roles) are mapped
  too; wherever CS Lead was allowed, Head and Lead both are. Nobody is added to Lead.
- **Live configuration is grandfathered** (migration 0031). Every agent, active prompt, router, queue,
  SLA policy, channel, rule, template, provider, profile, manual price, shared MCP connection, destination, webhook, SSO
  provider and user that was live gets one approval record (`origin = MIGRATION`). Nothing that runs
  today changes. Its *next* change is a proposal, and the exception report lists these once as
  *installed only*.
- **Routing was backfilled** (migration 0025). Each channel got a pass-through router named after it,
  sending customers to the agent it answered as before.
- **Audit history ships to the store.** Existing `audit_events` are backfilled with team scope in one
  UPDATE (minutes per million rows; run `VACUUM (ANALYZE) audit_events` afterwards) and then shipped by
  the worker. Watch **System → Audit store** until the backlog reaches zero, then check the chain
  (section 10).

**Migrations are normally expand/contract.** A release normally adds only schema that the previous
release tolerates, and destructive changes ship one release later, which keeps a rolling restart and
an image rollback safe. **The governance and routing release is an exception** (above): it renames
roles in place (0021), and the previous release fails on every authenticated request against it.

**Rolling back the application.** Within releases that follow the rule, redeploy the previous image
tag; the schema stays at the newer version, which the previous release tolerates. To go back past the
governance and routing release, do not redeploy the old image: restore the pre-upgrade backup instead
(below). That discards everything that happened after the upgrade.

**Rolling back the schema.** Restore the pre-upgrade backup (section 5): PostgreSQL and the `secrets`
volume. There are no down-migrations. When rolling back past the governance and routing release, the
audit database and its secrets did not exist before it; remove the `audit-db` service and the
`auditdata` volume, or leave them unused by the older release.

**PostgreSQL major upgrades** (18 → 19) use `pg_upgrade` or dump/restore into a new volume. The
volume is mounted at `/var/lib/postgresql`, the PG18+ layout, so `pg_upgrade --link` works.

## 5. Backup and restore

Back up these things together. Any one is useless without the others:

1. **PostgreSQL.** Conversations, configuration, encrypted credentials, and the recent local window
   of audit events.
2. **The audit store** (`audit-db`, the `auditdata` volume): the system of record for audit events
   (section 10).
3. **The `blobs` volume.** Media, attachments and the signed audit exports. On the `s3` profile, back
   up the `s3data` volume instead.
4. **The `secrets` volume**, above all `app/master_key` and `app/audit_signing_key`. Without it, the encrypted provider, channel
   and MCP credentials in PostgreSQL cannot be decrypted. Store it separately from the database
   backup, for example in a password manager or a KMS-encrypted object, and restrict access.

```bash
# Backup (online; consistent snapshot of the database)
# Keep backups OUTSIDE the repository checkout (never commit them).
B=~/ocso-backups && mkdir -p "$B" && chmod 700 "$B" && ts=$(date +%Y%m%d-%H%M%S)
docker compose exec -T postgres pg_dump -U ocso -d ocso -Fc > "$B/ocso-$ts.dump"
docker compose exec -T audit-db pg_dump -U ocso_audit -d ocso_audit -Fc > "$B/ocso-audit-$ts.dump"
docker run --rm -v ocso_blobs:/data:ro -v "$B":/b busybox tar czf /b/blobs-$ts.tgz -C /data .
docker run --rm -v ocso_secrets:/data:ro -v "$B":/b busybox tar czf /b/secrets-$ts.tgz -C /data .
chmod 600 "$B"/*

# Restore into a fresh stack
docker compose down                       # add -v only if you really mean to replace all data
docker run --rm -v ocso_secrets:/data -v "$B":/b busybox tar xzf /b/secrets-<ts>.tgz -C /data
docker run --rm -v ocso_blobs:/data -v "$B":/b busybox tar xzf /b/blobs-<ts>.tgz -C /data
docker compose up -d postgres
docker compose exec -T postgres pg_restore -U ocso -d ocso --clean --if-exists < "$B/ocso-<ts>.dump"
docker compose up -d audit-db
# The audit store is append-only (its tables refuse DELETE/TRUNCATE): restore into its fresh, empty database;
# the next migrate step re-creates the writer role and its grants.
docker compose exec -T audit-db pg_restore -U ocso_audit -d ocso_audit --no-privileges < "$B/ocso-audit-<ts>.dump"
docker compose up -d                      # migrate brings the schema forward if the dump is older
```

**If only the audit store is restored** (the main database is newer than the audit dump), events
shipped after the dump are no longer in the store although the main database marks them verified.
Reconciliation and the local prune check the store again and ship them once more, but only while
they are inside the local window (`audit_local_window_days`): restore the store promptly, then
confirm with `audit-verify` (section 10) and the System screen (**Full check**, **Shipping**). The
restored chain continues from the dump's head, so positions after it are sealed again with other
content than earlier exports under `audit-exports/` covered — keep those exports; each still
verifies against its own manifest.

Volume names carry the Compose project prefix (`ocso_`); check them with `docker volume ls`.
Restore the `secrets` volume before PostgreSQL starts for the first time. Otherwise `keygen` creates
new keys that do not match the restored data.

**Conversation recovery.** All conversation state lives in PostgreSQL. Queue jobs are rows in the
same database. After a crash or restore, workers reclaim expired leases and continue from the
persisted interactions (docs/10 §9). Turns that were in flight at the moment of failure are retried.
Replies are idempotent, so none is sent twice.

## 6. Secret hardening for production

The default layout protects the database and backups: credentials are envelope-encrypted with the
master key (ADR-012). It does **not** protect against someone with root on the host, who can read
the volume. Recommended practice:

- **Restrict the host.** Allow no interactive users besides operators. Docker access is root access,
  so control membership of the `docker` group.
- **Move the master key off the data volume.** Use a Docker secret from a root-only file (mode 0400)
  on an encrypted disk, and point `OCSO_SECRETS_MASTER_KEY_FILE` at it with an override file. On a
  cloud VM, fetch it at boot from the provider's secret manager (e.g. AWS Secrets Manager or SSM with
  the instance role) into a tmpfs.
- **Rotate what can be rotated.** Provider, channel and MCP credentials rotate from the UI (new
  SecretStore version). To rotate the blob or internal signing keys, delete the file on the volume,
  run `docker compose up -d keygen`, then restart api and worker. Outstanding signed URLs and visitor
  tokens are invalidated.
- **Use managed dependencies.** Managed PostgreSQL: set `DATABASE_URL` and `DATABASE_SSL=true` in
  `.env`; an explicit value wins over the generated file. Real S3: `BLOB_DRIVER=s3` with your
  bucket, and credentials from an instance role. For that, remove `S3_ENDPOINT` and
  `AWS_SHARED_CREDENTIALS_FILE` from the api and worker environment in a `compose.override.yaml`.
- **Terminate TLS in front of port 3000**, for example with the Caddy overlay
  ([HTTPS](#https-with-the-bundled-caddy-overlay)). Keep `SESSION_COOKIE_SECURE=true`.
- **Keep the containers hardened.** They run as non-root with a read-only root filesystem,
  `no-new-privileges`, and all capabilities dropped. Do not relax this in overrides.
- **Never** put secrets in `compose.yaml`, commit `.env`, or paste secrets into issues or logs. The
  application never logs secret values.

## 7. Observability

```bash
OTEL_ENABLED=true docker compose --profile observability up -d
open http://127.0.0.1:16686     # Jaeger UI: ocso-api / ocso-worker traces
```

api and worker export OTLP/HTTP to `otel-collector:4318`. The collector config is
`infra/compose/otel-collector.yaml`: traces go to Jaeger, and metrics and logs go to the debug
exporter. Point its exporters at your own backend. On EC2 with an instance role, you can send to
CloudWatch through the `sigv4auth` extension (research/05 §7). Health checks are excluded from
traces. In-product dashboards read PostgreSQL and do not need this profile (ADR-016).

## 8. S3-compatible blob storage (optional)

```bash
BLOB_DRIVER=s3 docker compose --profile s3 up -d
```

This profile runs SeaweedFS (Apache-2.0, ADR-011); MinIO is not used. The `s3-init` one-shot creates
the `ocso-media` bucket, and credentials come from the `secrets` volume. Switching drivers does not
migrate existing blobs. Pick one before going live.

## 9. Email (Resend or SMTP)

OCSO sends invites, password resets, email verification and sign-in codes, security notices (password
changed, new sign-in) and alert emails through one deployment-wide sender. Email is authentication
infrastructure, so it is configured here — environment and secret files — and never in the web app.
**Settings → Email** shows Tech admins what is configured and has a **Send test email** button.

| Variable | Meaning |
|---|---|
| `EMAIL_DRIVER` | A registered email driver: `resend` (recommended), `smtp`, or `log` (development only; production needs `EMAIL_ALLOW_LOG_IN_PRODUCTION=true`). An unknown name fails start-up and lists the registered drivers |
| `EMAIL_FROM` | Sender, e.g. `Acme Support <support@mail.acme.com>`, on a domain verified with the provider |
| `EMAIL_REPLY_TO` | Optional reply address, e.g. your support inbox |
| `RESEND_API_KEY_FILE` | File with the Resend API key (`RESEND_API_KEY` also works, but leaves the key in `.env`) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD_FILE` | SMTP relay; `SMTP_SECURE=true` for implicit TLS on 465, otherwise STARTTLS is required (`SMTP_REQUIRE_TLS=false` only for a local relay) |

**Resend setup.**

1. In Resend, **Domains → Add domain**. Use a subdomain you send from, such as `mail.acme.com`, so the
   reputation of your main domain stays separate.
2. At your DNS provider, create the records Resend shows, copying the values exactly: the DKIM `TXT`
   record at `resend._domainkey`, and the `MX` and SPF `TXT` records on the `send` sub-subdomain (the
   bounce / Return-Path domain). Add a DMARC `TXT` record at `_dmarc` if the domain has none, e.g.
   `v=DMARC1; p=none; rua=mailto:dmarc@acme.com`; Resend does not create it. Wait until the domain
   shows **Verified** (usually minutes; DNS can take longer).
3. **API Keys → Create API key** with **Sending access**, restricted to that domain.
4. Store the key on the `secrets` volume (it never goes into `compose.yaml` or git), then configure `.env`:

```bash
read -rs KEY && printf '%s' "$KEY" | docker compose run --rm -T --no-deps keygen sh -c \
  'umask 277 && cat > /secrets/app/resend_api_key && chown 1000:1000 /secrets/app/resend_api_key'; unset KEY
```

```dotenv
EMAIL_DRIVER=resend
EMAIL_FROM=Acme Support <support@mail.acme.com>
EMAIL_REPLY_TO=support@acme.com
RESEND_API_KEY_FILE=/run/secrets/ocso/resend_api_key
```

5. `docker compose up -d`, then **Settings → Email → Send test email**. Include the file in your
   `secrets` volume backups (section 5). To rotate, overwrite the file the same way and restart api and worker.

OCSO sends each message with an `Idempotency-Key`, so retries never send twice. Rate limits (`429`) and
Resend outages are retried for alert emails; a rejected key or an unverified domain fails at once and
the test button reports it as an `auth` error.

**SMTP.** Any relay works (Amazon SES SMTP, Postmark, Mailgun, a corporate relay, or Resend's own SMTP
at `smtp.resend.com`, user `resend`, password = API key). Write the password to
`/secrets/app/smtp_password` like the Resend key above and set `EMAIL_DRIVER=smtp`, `EMAIL_FROM`,
`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER` and `SMTP_PASSWORD_FILE=/run/secrets/ocso/smtp_password`.

**Alert emails.** Email alert destinations send with this deployment sender by default ("Send with:
deployment" — only recipients to enter). A destination can still use its own SMTP relay.

## 10. The audit store (ADR-032)

Audit events are written in the same transaction as each change into the main database
(`audit_events`, the transactional outbox), and the worker leader moves them to the **audit store**,
a separate database that is the system of record:

- **ship** (every 2 s): unshipped events are appended to the store (idempotent);
- **reconcile** (every 5 min): shipped events are looked up in the store, marked verified, or sent
  again if the store lost them;
- **seal** (every 10 s): new records are added to a SHA-256 hash chain; every 1 000 entries (or
  hourly) the worker re-verifies what is new since the last checkpoint and signs a checkpoint with the
  Ed25519 key (a break found on the way is recorded as `CHAIN_BROKEN`; later ranges that verify on
  their own are still signed);
- **verify-full** (daily, in pages every minute until done): the whole chain is re-verified, so an
  old record altered later is found;
- **export** (daily): the sealed range up to the latest checkpoint is written to the blob store as
  `audit-exports/YYYY/MM/DD/<from>-<to>.ndjson.gz` plus a signed `.manifest.json`.

The main database keeps a local window of verified events (`audit_local_window_days`, default 90,
minimum 90) and never deletes one the store has not confirmed — it checks the store again right
before deleting. The audit screen reads the store
merged with events not shipped yet. If the store is down, OCSO keeps working: events wait in the
outbox, the System screen shows **Audit store · down** and an incident, and the audit screen serves
the local copy. Readiness (`/health/ready`) does not depend on the store; `/health/dependencies`
reports it with the shipping lag.

The worker connects as `ocso_audit_writer` (INSERT and SELECT only) and the api as
`ocso_audit_reader` (SELECT only). `UPDATE`, `DELETE` and `TRUNCATE` are refused by triggers for
every role; only the owner (credentials in the `migrate` container alone) could disable them. Months
past the audit retention are dropped whole by a `SECURITY DEFINER` function that never goes below
`AUDIT_MIN_RETENTION_DAYS` (at least 365; set it to your regulatory retention, e.g. 2555) and logs
each drop. Every store call is bounded (`AUDIT_STORE_TIMEOUT_MS`, default 15 s), so a store that
stops answering never stalls the worker's other scheduled work.

**A chain break** (`CHAIN_BROKEN` on the System screen, with the positions): investigate with
`audit-verify --from <first> --to <last>`, then **Acknowledge break** (needs `audit.verify`) with a
note of what was found. The acknowledgement is audited; nothing in the store is rewritten.

**Rotating the signing key:** put the new PEM in `app/audit_signing_key`, keep the old public key
(`openssl pkey -in old.pem -pubout`) in a file named by `AUDIT_TRUSTED_PUBLIC_KEYS_FILE`, and restart
api and worker. Keygen creates a new key if the file is missing, so a lost `secrets` volume shows up
as **Checkpoints were signed by a key this deployment does not trust** (`SIGNING_KEY_CHANGED`) —
restore the old key rather than trusting a new one blindly.

**Verify the chain** from the System screen (**Verify recent entries**, needs `audit.verify`, which
Tech holds), with `POST /v1/audit/verify {from?, to?}`, or offline for any range:

```bash
docker compose run --rm migrate node audit-store/dist/bin/audit-verify.js --from 1
# exit 0 = verified; 1 = problems (JSON report: position, kind); 2 = could not run
```

An auditor verifies with public keys they pinned themselves (`GET /v1/audit/keys`, or
`--public-key audit_signing_key.pub.pem`) — never the key inside an export manifest. The bin also
fails when no valid checkpoint signs the range or more than `--max-unsigned` (default 5 000) entries
follow the last one. Exports are an independent copy only when the blob store keeps
`audit-exports/` write-once. OCSO does not enforce this: nothing in Compose or Terraform turns on S3
Object Lock, and OCSO does not check it. Configure it yourself on the bucket (the local `blobs` volume
cannot be made write-once).

**A managed PostgreSQL for the store:** set `AUDIT_DATABASE_URL` (writer), `AUDIT_READER_URL`
(reader) and `AUDIT_DATABASE_OWNER_URL` (owner; migrate only) in `.env`, `AUDIT_DATABASE_SSL=true`, and
`AUDIT_PROVISION_ROLE=false` if your DBA creates the writer role (the migrate step then only
applies the schema and grants). The owner may be a non-superuser that can create roles.

**ClickHouse instead:** `AUDIT_DRIVER=clickhouse` with `CLICKHOUSE_URL`, `CLICKHOUSE_DATABASE`,
`CLICKHOUSE_USER`/`CLICKHOUSE_PASSWORD` (the writer: SELECT and INSERT only),
`CLICKHOUSE_READER_USER`/`AUDIT_READER_PASSWORD` (the api: SELECT only),
`CLICKHOUSE_ADMIN_USER`/`CLICKHOUSE_ADMIN_PASSWORD` for the migrate step, and optionally
`CLICKHOUSE_PURGE_USER`/`CLICKHOUSE_PURGE_PASSWORD` for the worker (ClickHouse needs `ALTER DELETE`
to drop a partition, so retention purges run as that separate user; without it nothing is purged).
The `audit-db` service is then unused. ClickHouse cannot refuse writes by trigger: it is
tamper-evident (verification reports a second copy of a record or a second chain row), not
append-only, and the purge user can delete — treat it like owner credentials.

## 10a. Web chat: client addresses and rate limits

The public web chat routes are rate-limited per client address and per visitor (sessions 30/min per address,
messages 60/min per visitor, wrong secret keys on session-pass minting 30/min per channel and address;
`429 rate_limited` with `Retry-After`). Minting session passes with the right secret key is not limited: the
caller proved it holds the key, and a client- or user-mode site mints one per page view. The client address comes from `X-Forwarded-For` as allowed by `TRUST_PROXY` on the api:

- `TRUST_PROXY=true` (the Compose default) takes the left-most entry. With the Caddy overlay that entry is the real
  client: Caddy ignores any `X-Forwarded-For` a client sends and writes the connecting address itself, and the
  web app's rewrite passes it on. Per-address limits are reliable.
- Many visitors behind one address (an office or campus NAT) share the per-address session limit. Raise it with
  `OCSO_WEBCHAT_RATE_LIMITS=session=300` in `.env` (keys `sessionPassFailures`, `session`, `messages`, `attachments`,
  `stream`; requests per minute per api instance; `0` turns a limit off).
- Without a proxy that overwrites the header (the web port exposed directly), a client can put anything in
  `X-Forwarded-For`, so per-address limits are advisory; the per-channel and per-visitor limits still hold. Put a
  proxy in front, or set `TRUST_PROXY` to the number of proxy hops you do run (`1` behind one load balancer:
  the address that proxy appended), or `false` to use the socket peer.

Server-side callers of the public web chat API that send no `Origin` header (React Native apps, backends) need
the channel's auth mode `client`/`user` or "Allow native apps"; see `packages/ocso-chat/README.md`.

## 11. Troubleshooting

| Symptom | Check |
|---|---|
| `migrate` exited non-zero | `docker compose logs migrate`. An edited, already-applied migration is refused on purpose. Restore the file. |
| api stays `starting` or unhealthy | `docker compose logs api`. `Invalid OCSO configuration` lists the bad variable, with secret values hidden. A `*_DRIVER=<name> is not available` line lists the drivers this build registers. |
| `ocso-entrypoint: … unreadable file` | The `secrets` volume is missing a file. Run `docker compose up keygen` and check `docker compose logs keygen`. For `RESEND_API_KEY_FILE` / `SMTP_PASSWORD_FILE`, write the file first (section 9). |
| `EMAIL_DRIVER is required in production` | Configure email (section 9), or set `EMAIL_ALLOW_LOG_IN_PRODUCTION=true` for a trial without email. |
| Test email fails with `auth` | Resend: the domain in `EMAIL_FROM` is not verified, or the API key is revoked or restricted to another domain. SMTP: wrong user or password. |
| Login page loads but sign-in fails on a remote host over http | The session cookie is `Secure`. Use TLS, or set `SESSION_COOKIE_SECURE=false` for a trial. |
| Public webhook paths return 404 | They must be under `/channels`, `/public`, `/oauth`, `/.well-known` or `/blobs`. Only those are proxied to the API. |
| `seed` says "already set up by a person" | The demo seed only runs on a fresh database: `docker compose down -v` (deletes all data). |
| Worker replicas keep restarting | `docker compose logs worker`. Check model provider credentials and the database pool size against `max_connections`. |
| Port 3000 is taken | Set `OCSO_HTTP_PORT` in `.env`. |
| Start over completely | `docker compose --profile demo --profile observability --profile s3 down -v` (**deletes all data and keys**). |
