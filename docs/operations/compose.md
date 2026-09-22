# Running OCSO with Docker Compose

Single-host deployment (docs/13 §2): one machine, for example one EC2 instance, running every OCSO
process in containers. The same images run on ECS Fargate ([aws.md](aws.md)); only configuration
differs.

| Service | What it does | Published |
|---|---|---|
| `keygen` | One-shot. Creates missing secrets on the `secrets` volume, then exits | – |
| `postgres` | PostgreSQL 18, data on the `pgdata` volume | – |
| `migrate` | One-shot. Applies `packages/db/migrations`, then exits 0 | – |
| `api` | NestJS control plane, port 4000 | – (internal) |
| `worker` | Agent workers, health on 4100. Scale with `--scale worker=N` | – |
| `web` | Next.js UI and BFF. Proxies `/channels`, `/public`, `/oauth`, `/.well-known`, `/blobs` to the API | **3000** |

Profiles: `demo` (example MCP server and seed), `observability` (OTel Collector and Jaeger), and
`s3` (SeaweedFS instead of the local blob volume).

Only port 3000 is published. The staff API (`/v1/*`) is not reachable from outside: the browser talks
to Next.js, and Next.js calls the API over the internal network (ADR-020). PostgreSQL sits on an
`internal` network with no outbound internet.

## 1. Prerequisites

- Docker Engine 26+ with Compose v2.30+. Named-volume `subpath` mounts need these versions; this repo
  was verified on Engine 29.2 with Compose 5.1.
- 4 vCPU and 8 GB RAM are enough for a pilot. The image builds take about 3 GB of disk; data grows
  with conversations and media.
- To build: the repository checkout. The build works with the classic builder, and BuildKit/buildx
  is optional. To deploy prebuilt images you only need `compose.yaml`, `infra/compose/`, and `.env`.
- For anything beyond localhost, a TLS-terminating reverse proxy (Caddy, nginx, or an ALB) in front
  of port 3000, with `OCSO_PUBLIC_URL` set to the public `https://` origin.

## 2. First run

```bash
cp .env.example .env          # optional; every setting has a safe default
docker compose up -d --build  # keygen → postgres → migrate → api + worker → web
docker compose ps             # api, worker, web become "healthy"; keygen and migrate "exited (0)"
```

**Key generation.** Secrets are never in `compose.yaml`, `.env`, or git. On first start the `keygen`
one-shot writes each missing secret to the `secrets` named volume:

| File on the `secrets` volume | Used for |
|---|---|
| `postgres/db_password` (root, 0400) | PostgreSQL password |
| `app/database_url` | `postgres://ocso:<password>@postgres:5432/ocso` |
| `app/master_key` | SecretStore key-encryption key (ADR-012). Losing it loses every stored credential |
| `app/blob_signing_key` | HMAC for signed blob URLs |
| `app/internal_signing_key` | Identity-claims and visitor-token bootstrap key |
| `app/setup_token` | One-time `/setup` token |
| `app/demo_mcp_token`, `demo/*` | Demo MCP bearer token (`demo` profile) |
| `app/aws_credentials`, `seaweedfs/s3.json` | SeaweedFS S3 identity (`s3` profile; readable by SeaweedFS uid 1000 only) |

Existing files are never overwritten. Each container mounts only its own sub-directory, so the
postgres container never sees the master key. The images resolve `*_FILE` variables at start-up
(`infra/compose/ocso-entrypoint.sh`); the master key is read as a file by the app and never enters
the environment.

**Create the first Tech Admin.** Open `http://localhost:3000`. You are sent to `/setup`. Get the
one-time token with:

```bash
docker compose logs api | grep "setup token"
# or: docker compose exec api cat /run/secrets/ocso/setup_token
```

After setup the token no longer works: `/setup` refuses once a user exists.

**Or seed the Meridian Bank demo** (only on a fresh database):

```bash
OCSO_DEMO_SEED=true docker compose --profile demo up -d --build
docker compose logs seed      # prints the logins
```

This creates:
- **Organization.** Meridian Bank, `ap-south-1`, `Asia/Kolkata`, residency `IN`.
- **Users.** Tech Admin Tarun Shetty, CS Lead Anjali Rao, CS Execs Nikhil Menon and Meera Pillai.
  Emails are `@meridian.example`. The password for all of them is `OCSO_DEMO_PASSWORD`, which
  defaults to `meridian-demo-2026`.
- **Teams.** Three teams.
- **Queues.** Four queues with SLA policies.
- **Models.** The development-only scripted model provider, plus the profiles `support-primary`,
  `support-fast`, `sales-primary` and `summarizer`.
- **Agents.** Maya, Arjun and Riya, with curated prompt versions and escalation rules, all LIVE.
- **Channels.** A web chat channel.
- **MCP.** The demo MCP server `meridian-core`, discovered, authenticated, classified and approved
  for Maya, with `payments.reverse_transaction` above ₹5,000 requiring confirmation.
- **Alerts.** The default alert rules.

Everything is created through the application services, so it appears in the audit log. The seed is
idempotent: later runs exit immediately.

`OCSO_DEMO_SEED=true` also enables the scripted model provider (ADR-015) for api, worker and seed.
Never use it for a real deployment.

## 3. Everyday operations

```bash
docker compose ps                         # state and health
docker compose logs -f api worker         # JSON logs (pino); rotated at 10 MB × 5 per container
docker compose up -d --scale worker=3     # more agent capacity (docs/10)
docker compose restart worker             # graceful: 90 s to finish or checkpoint turns
docker compose down                       # stop (volumes kept)
```

**Scaling workers.** Workers hold conversation leases in PostgreSQL. Any worker can take over a
conversation whose lease expired, so scaling up or down never loses a conversation (docs/10 §9).
The Tech Admin worker settings (min/max workers, target utilization) are advisory under Compose
(`DEPLOYMENT_DRIVER=compose`): you choose the replica count. The worker settings page shows the exact
`--scale worker=N` command for the warm floor (see [worker-scaling.md](worker-scaling.md)). Size `DATABASE_POOL_SIZE` × (api + all
workers) below PostgreSQL's `max_connections` (100 by default).

**Health endpoints.**
- api: `/health/live`, `/health/ready` (database) and `/health/dependencies` (Tech Admin token required), on the internal
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

**Migrations are expand/contract.** A release only adds schema that the previous release tolerates.
Destructive changes ship one release later. This keeps a rolling restart and a rollback safe.

**Rolling back the application.** Redeploy the previous image tag. The schema stays at the newer
version, which the previous release tolerates by the rule above.

**Rolling back the schema.** Restore the pre-upgrade backup. There are no down-migrations.

**PostgreSQL major upgrades** (18 → 19) use `pg_upgrade` or dump/restore into a new volume. The
volume is mounted at `/var/lib/postgresql`, the PG18+ layout, so `pg_upgrade --link` works.

## 5. Backup and restore

Back up these three things together. Any one is useless without the others:

1. **PostgreSQL.** This is the system of record: conversations, configuration, audit, and encrypted
   credentials.
2. **The `blobs` volume.** Media and attachments. On the `s3` profile, back up the `s3data` volume
   instead.
3. **The `secrets` volume**, above all `app/master_key`. Without it, the encrypted provider, channel
   and MCP credentials in PostgreSQL cannot be decrypted. Store it separately from the database
   backup, for example in a password manager or a KMS-encrypted object, and restrict access.

```bash
# Backup (online; consistent snapshot of the database)
# Keep backups OUTSIDE the repository checkout (never commit them).
B=~/ocso-backups && mkdir -p "$B" && chmod 700 "$B" && ts=$(date +%Y%m%d-%H%M%S)
docker compose exec -T postgres pg_dump -U ocso -d ocso -Fc > "$B/ocso-$ts.dump"
docker run --rm -v ocso_blobs:/data:ro -v "$B":/b busybox tar czf /b/blobs-$ts.tgz -C /data .
docker run --rm -v ocso_secrets:/data:ro -v "$B":/b busybox tar czf /b/secrets-$ts.tgz -C /data .
chmod 600 "$B"/*

# Restore into a fresh stack
docker compose down                       # add -v only if you really mean to replace all data
docker run --rm -v ocso_secrets:/data -v "$B":/b busybox tar xzf /b/secrets-<ts>.tgz -C /data
docker run --rm -v ocso_blobs:/data -v "$B":/b busybox tar xzf /b/blobs-<ts>.tgz -C /data
docker compose up -d postgres
docker compose exec -T postgres pg_restore -U ocso -d ocso --clean --if-exists < "$B/ocso-<ts>.dump"
docker compose up -d                      # migrate brings the schema forward if the dump is older
```

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
  on an encrypted disk, and point `OCSO_SECRETS_MASTER_KEY_FILE` at it with an override file. On EC2,
  fetch it at boot from AWS Secrets Manager or SSM with the instance role, into a tmpfs.
- **Rotate what can be rotated.** Provider, channel and MCP credentials rotate from the UI (new
  SecretStore version). To rotate the blob or internal signing keys, delete the file on the volume,
  run `docker compose up -d keygen`, then restart api and worker. Outstanding signed URLs and visitor
  tokens are invalidated.
- **Use managed dependencies.** Managed PostgreSQL: set `DATABASE_URL` and `DATABASE_SSL=true` in
  `.env`; an explicit value wins over the generated file. Real S3: `BLOB_DRIVER=s3` with your
  bucket, and credentials from an instance role. For that, remove `S3_ENDPOINT` and
  `AWS_SHARED_CREDENTIALS_FILE` from the api and worker environment in a `compose.override.yaml`.
- **Terminate TLS in front of port 3000.** Keep `SESSION_COOKIE_SECURE=true`.
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

## 9. Troubleshooting

| Symptom | Check |
|---|---|
| `migrate` exited non-zero | `docker compose logs migrate`. An edited, already-applied migration is refused on purpose. Restore the file. |
| api stays `starting` or unhealthy | `docker compose logs api`. `Invalid OCSO configuration` lists the bad variable, with secret values hidden. |
| `ocso-entrypoint: … unreadable file` | The `secrets` volume is missing a file. Run `docker compose up keygen` and check `docker compose logs keygen`. |
| Login page loads but sign-in fails on a remote host over http | The session cookie is `Secure`. Use TLS, or set `SESSION_COOKIE_SECURE=false` for a trial. |
| Public webhook paths return 404 | They must be under `/channels`, `/public`, `/oauth`, `/.well-known` or `/blobs`. Only those are proxied to the API. |
| `seed` says "already set up by a person" | The demo seed only runs on a fresh database: `docker compose down -v` (deletes all data). |
| Worker replicas keep restarting | `docker compose logs worker`. Check model provider credentials and the database pool size against `max_connections`. |
| Port 3000 is taken | Set `OCSO_HTTP_PORT` in `.env`. |
| Start over completely | `docker compose --profile demo --profile observability --profile s3 down -v` (**deletes all data and keys**). |
