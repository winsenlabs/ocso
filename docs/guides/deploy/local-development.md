# Run OCSO from source

This page is for contributors and plugin authors who want the api, worker and web app running from a
checkout with their own changes in them. It covers the toolchain, the two databases (the main database
and the audit store), the environment the processes need, migrations, the three dev processes, the
demo seed and the development-only scripted model.

To see the product without building anything, use the Compose demo instead
([docker-compose.md](docker-compose.md)). To run the tests, see [CONTRIBUTING.md](../../../CONTRIBUTING.md#tests).
Most day-to-day work does not need a running stack: unit and integration tests exercise the services
directly, and the Playwright tests start their own stack.

> [!NOTE]
> There is no single `pnpm dev` for the whole stack yet. You start the api, the worker and the web app
> in three terminals.

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Node.js | 26 (`.nvmrc`) | `package.json` `engines` allows 24 or later, but CI and the images use 26. `nvm use` or `fnm use` picks it up. |
| pnpm | 11.1.2 | Pinned in `packageManager`. `corepack enable` installs it. |
| PostgreSQL | 18 | The main database and the audit store. One server can hold both for development. |
| Docker | Engine 26+ | Optional, the easiest way to get PostgreSQL 18. |
| `psql` | any recent | Optional here; the Playwright and resilience scripts need it on your `PATH`. |

## What runs

```mermaid
flowchart LR
  browser["Browser"] --> web["web: Next.js dev server :3000"]
  web -->|"rewrites to API_URL"| api["api: NestJS :4000"]
  api --> pg[("PostgreSQL: ocso")]
  worker["worker: health :4100"] --> pg
  worker -->|"writer role"| audit[("PostgreSQL: ocso_audit")]
  api -->|"reads"| audit
```

The worker is the only process that writes to the audit store. The api reads it. Queues are rows in the
main database (`QUEUE_DRIVER=postgres`, the default), so there is no broker to run.

## 1. Clone, install, build

```bash
git clone https://github.com/winsenlabs/ocso.git && cd ocso
nvm use                    # or: fnm use
corepack enable
pnpm install
pnpm build                 # every package and app (turbo)
```

The api's `dev` script and the worker's `start` script run the compiled `dist/` output, so build once
before you start them.

## 2. Start PostgreSQL 18

```bash
docker run -d --name ocso-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:18
docker exec ocso-pg createdb -U postgres ocso
```

You do not need to create the audit database: `audit-migrate` (step 5) creates it through the server's
`postgres` database when it is missing.

## 3. Write the environment

The api reads a repository-root `.env` by itself (its `dev` script passes `--env-file-if-exists=../../.env`).
The worker, the migration bins and the seed do not, so you export the same file into their shells.

Generate the two keys first:

```bash
openssl rand -base64 32    # OCSO_SECRETS_MASTER_KEY: exactly 32 bytes, base64
openssl rand -base64 24    # BLOB_SIGNING_KEY: at least 16 characters
```

A minimal `.env` for development:

```dotenv
NODE_ENV=development
LOG_LEVEL=info

# Main database
DATABASE_URL=postgres://postgres:postgres@localhost:5432/ocso

# Audit store (ADR-032). The worker writes with this role; audit-migrate creates it.
AUDIT_DRIVER=postgres
AUDIT_DATABASE_URL=postgres://ocso_audit_writer:dev-writer-password@localhost:5432/ocso_audit
# Used only by audit-migrate (creates the database, schema and writer role).
AUDIT_DATABASE_OWNER_URL=postgres://postgres:postgres@localhost:5432/ocso_audit

# Local secret store (AES-256-GCM envelope encryption in PostgreSQL)
SECRETS_DRIVER=local
OCSO_SECRETS_MASTER_KEY=<output of openssl rand -base64 32>

# Local blob store. Use an absolute path: the api and the worker run from different
# directories and must share it.
BLOB_DRIVER=local
BLOB_LOCAL_DIR=/absolute/path/to/ocso/data/blobs
BLOB_SIGNING_KEY=<output of openssl rand -base64 24>

# Public origin: where the browser, the widget and provider webhooks reach OCSO
OCSO_PUBLIC_URL=http://localhost:3000

# Optional: a fixed first-run token (at least 16 characters). Without it the api
# generates one on every start and logs it.
OCSO_SETUP_TOKEN=local-setup-token-change-me

# Optional: the scripted model provider (development only, ADR-015)
OCSO_ENABLE_DEV_PROVIDERS=true
```

Things you do not have to set in development:

| Setting | Development behaviour |
|---|---|
| `AUDIT_SIGNING_KEY_FILE` | Without it, the api and worker create and share a development key at `.ocso/audit_signing_key.pem` in the workspace root (git-ignored) and log a warning. Production refuses to start without a key. |
| `BETTER_AUTH_SECRET` | Required only when `NODE_ENV=production`. |
| `EMAIL_DRIVER` | Defaults to `log`: invites, resets and sign-in codes are written to the api and worker logs instead of sent. See [Email](../email.md). |
| `QUEUE_DRIVER`, `DEPLOYMENT_DRIVER` | Default to `postgres` and `compose`. |
| `SESSION_COOKIE_SECURE` | Defaults to `true` only when `OCSO_PUBLIC_URL` is `https`. |

`packages/config/src/env.ts` is the complete, validated list, and
[apps/web/e2e/stack/start-api.mjs](../../../apps/web/e2e/stack/start-api.mjs) is a working minimal
environment for the api and worker. The [configuration reference](../../reference/configuration.md)
describes every variable.

> [!WARNING]
> Do not reuse this `.env` for Docker Compose. Compose reads the same file for interpolation, and a
> non-empty `DATABASE_URL` there overrides the generated one, pointing the containers at `localhost`.
> Keep the from-source `.env` in a checkout you do not run Compose from, or rename it and load it by hand.

## 4. Apply the main migrations

```bash
set -a; . ./.env; set +a
node packages/db/dist/bin/migrate.js
```

The runner takes a PostgreSQL advisory lock, applies each file in `packages/db/migrations/` in its own
transaction, and refuses to run if a file it already applied was edited. It exits 2 if `DATABASE_URL` is
missing and 1 on any failure. Migrations never run when the api or worker starts.

## 5. Provision the audit store

```bash
node packages/audit-store/dist/bin/audit-migrate.js
```

With `AUDIT_DRIVER=postgres` this connects with `AUDIT_DATABASE_OWNER_URL`, creates `ocso_audit` if it is
missing, applies the audit schema, and creates the writer role named in `AUDIT_DATABASE_URL` with the
password in that URL. It also sets the store's minimum retention (`AUDIT_MIN_RETENTION_DAYS`, default 365).
Set `AUDIT_READER_URL` too if you want a separate SELECT-only role for the api, as production does; the api
then uses that URL as its `AUDIT_DATABASE_URL`.

Both steps are idempotent. Run them again after every `git pull` that adds a migration.

## 6. Start the three processes

Each in its own terminal, from the repository root:

```bash
# Terminal 1: api on :4000, rebuilds and restarts on change; reads ./.env itself
pnpm --filter @ocso/api dev

# Terminal 2: worker, health on :4100; export the environment first
set -a; . ./.env; set +a
pnpm --filter @ocso/worker start

# Terminal 3: Next.js on http://localhost:3000
pnpm --filter @ocso/web dev
```

- The web app proxies the public ingress paths (`/channels`, `/public`, `/oauth`, `/.well-known`,
  `/blobs`) and its own backend-for-frontend calls to `API_URL`, which defaults to `http://localhost:4000`.
- The worker has no watch mode. After changing worker code, run `pnpm --filter @ocso/worker build` (or
  `pnpm build`) and restart it. The same goes for packages both processes use.
- Run more than one worker by starting another with a different `HEALTH_PORT` and `WORKER_ID`.

## 7. First run or demo data

**Empty deployment.** Open `http://localhost:3000`. You are sent to `/setup`. The token is your
`OCSO_SETUP_TOKEN`, or the one the api logged:

```text
First-run setup required. Open /setup in the web UI and use setup token: <token>
```

Then follow [First-run setup](../first-run-setup.md).

**Meridian Bank demo instead.** On a fresh database (no user created yet):

```bash
set -a; . ./.env; set +a
OCSO_DEMO_SEED=true OCSO_ENABLE_DEV_PROVIDERS=true pnpm --filter @ocso/api seed
```

The seed prints the demo logins. Every demo account uses `OCSO_DEMO_PASSWORD`, which defaults to
`meridian-demo-2026` (at least 12 characters if you set it). It refuses to run on a deployment a person
already set up, and later runs exit immediately.

The MCP step of the seed runs only when `MCP_DEMO_URL` and `DEMO_MCP_TOKEN` are set. To include it, start
the example server first, on a port that does not collide with the worker's health port:

```bash
pnpm --filter ./examples/mcp-bank-demo build
PORT=8080 DEMO_MCP_TOKEN=local-demo-mcp-token-123 pnpm --filter ./examples/mcp-bank-demo start
# then add to the seed command:
#   MCP_DEMO_URL=http://localhost:8080/mcp DEMO_MCP_TOKEN=local-demo-mcp-token-123
```

The seed adds the demo server's host to the egress allowlist for internal hosts, with an approval, so the
SSRF guard lets OCSO reach it.

## 8. The development-only scripted model

`OCSO_ENABLE_DEV_PROVIDERS=true` registers the provider **Scripted model (development only)** on the api,
worker and seed. It returns scripted replies with a configurable latency and never calls a network model,
which is what the demo, the Playwright tests and the resilience scripts use. It is refused when
`NODE_ENV=production` unless `OCSO_ALLOW_DEV_PROVIDERS_IN_PRODUCTION=true` is also set (the Compose demo
sets both). Never enable it on a real deployment.

To use a real model instead, add a provider under **Integrations → Models** and paste an API key; see
[Model providers](../models/README.md).

## Verify it works

- `curl -s localhost:4000/health/ready` returns 200 once the api can reach PostgreSQL.
- `curl -s localhost:4100/health/ready` returns 200 for the worker.
- `http://localhost:3000/login` renders.
- After signing in as a Tech user, **Platform → Workers** lists the worker under **Worker fleet**, and
  **Platform → System** shows the **Audit store** panel without an error.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `Invalid OCSO configuration:` followed by a list | `packages/config` rejected a variable. Secret values are hidden in the message. Fix the named variable. |
| `SECRETS_DRIVER=local requires OCSO_SECRETS_MASTER_KEY or OCSO_SECRETS_MASTER_KEY_FILE` | Set the master key. It must decode to exactly 32 bytes. |
| `BLOB_DRIVER=local requires BLOB_SIGNING_KEY` | Set `BLOB_SIGNING_KEY` (16 characters or more). |
| `AUDIT_DRIVER=postgres requires AUDIT_DATABASE_URL (or AUDIT_DATABASE_URL_FILE)` | The api or worker has no audit store URL. Usually the worker's shell was not given the `.env`. |
| `audit-migrate (postgres) needs AUDIT_DATABASE_OWNER_URL and AUDIT_DATABASE_URL` | Export both before running `audit-migrate.js`. |
| `migration NNNN_x.sql was modified after being applied` | Someone edited a committed migration. Restore the file; fix forward with a new migration. |
| `The demo seed uses the development-only scripted model provider` | Set `OCSO_ENABLE_DEV_PROVIDERS=true` for the seed. |
| `This deployment was already set up by a person` | The seed only runs on a fresh database. Drop and recreate `ocso` and `ocso_audit`, then migrate again. |
| Images or attachments 404 in the web app | The api and worker use different `BLOB_LOCAL_DIR` values. Use one absolute path. |
| The web app says **The OCSO API is not reachable.** on `/setup` | The api is not running on `API_URL` (default `http://localhost:4000`). |

## Limits and known gaps

- No single command starts the whole stack, and the worker has no watch mode.
- The api's `dev` script watches the api only. Changes in `packages/*` need a build of that package.
- Email defaults to the `log` driver, so nothing reaches an inbox until you configure
  [email](../email.md).

## Related

- [Docker Compose on one VM](docker-compose.md)
- [First-run setup](../first-run-setup.md)
- [Configuration reference](../../reference/configuration.md)
- [CONTRIBUTING.md](../../../CONTRIBUTING.md)
- [Resilience and load testing](../../operations/resilience-testing.md)
