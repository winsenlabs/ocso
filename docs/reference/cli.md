# CLI and operations commands

The command-line entry points OCSO ships: deployment steps (migrations, audit store provisioning and verification,
the demo seed, key generation) and repository scripts (capability catalog, evals, model catalog, resilience tests,
lint). This page is for operators and contributors. OCSO has no single `ocso` CLI; each command below is a Node
script with the flags listed here, taken from its source.

> [!NOTE]
> Server-side commands read their settings from the environment, like the api and worker. See
> [configuration](configuration.md). Inside the Compose images, `<VAR>_FILE` settings are resolved by the
> entrypoint first.

## Summary

| Command | Where it runs | Purpose |
|---|---|---|
| [`migrate.js`](#migrate) | migrate image, or `packages/db/dist/bin/migrate.js` | Apply main database migrations |
| [`audit-migrate`](#audit-migrate) | migrate image, `audit-store/dist/bin/audit-migrate.js` | Provision the audit store |
| [`audit-verify`](#audit-verify) | migrate image, `audit-store/dist/bin/audit-verify.js` | Verify the audit hash chain and signatures |
| [`seed.js`](#demo-seed) | api image, or `pnpm --filter @ocso/api seed` | Seed the Meridian Bank demo |
| [`keygen.mjs`](#keygen-compose) | Compose `keygen` service | Create missing secrets on the `secrets` volume |
| [`pnpm capabilities:generate` / `capabilities:check`](#capabilitiesgenerate-and-capabilitiescheck) | repository | Ask OCSO capability catalog |
| [`pnpm evals:ask-ocso`](#pnpm-evalsask-ocso) | repository | Ask OCSO evaluation suite |
| [`refresh-model-catalog.mjs`](#refresh-model-catalogmjs) | repository | Refresh the bundled model catalog snapshot |
| [`pnpm test:chaos` / `test:load`](#pnpm-testchaos-and-pnpm-testload) | repository | Resilience tests |
| [`pnpm lint`](#pnpm-lint) | repository | Source guards and the plugin boundary |

## migrate

Applies the hand-written SQL migrations in `packages/db/migrations/` with OCSO's own runner (ADR-004). It is an
explicit deployment step: the api and the worker never migrate at start-up.

```bash
# Compose: the one-shot `migrate` service runs this, then audit-migrate, on every `up`
docker compose run --rm migrate

# From source
DATABASE_URL=postgres://… node packages/db/dist/bin/migrate.js
```

- **Arguments:** none. It is not a product CLI.
- **Environment:** `DATABASE_URL` (required), `DATABASE_SSL` (`true` to enable TLS), `OCSO_MIGRATIONS_DIR`
  (optional override of the migrations folder).
- **Output:** JSON log lines; the last is `{"msg":"migrations complete","applied":N,"skipped":N}`.
- **Exit codes:** `0` success, `1` a migration failed, `2` `DATABASE_URL` missing.
- The runner stores a checksum per applied file and refuses to run if a committed migration changed.

The migrate image's default command is
`node dist/bin/migrate.js && node audit-store/dist/bin/audit-migrate.js`.

## audit-migrate

Applies the selected audit store driver's schema with owner credentials and ensures the writer (and reader) role or
user exists (ADR-032). Never run by the api or the worker.

```bash
docker compose run --rm migrate node audit-store/dist/bin/audit-migrate.js
```

- **Arguments:** none.
- **Environment:** `AuditToolsEnv`: `AUDIT_DRIVER`, and for `postgres` `AUDIT_DATABASE_OWNER_URL` and
  `AUDIT_DATABASE_URL` (or their `_FILE` forms), optionally `AUDIT_READER_URL`, `AUDIT_WRITER_PASSWORD`,
  `AUDIT_READER_PASSWORD`, `AUDIT_PROVISION_ROLE`, `AUDIT_MIN_RETENTION_DAYS`, `AUDIT_ALLOW_OWNER_WRITER`; for
  `clickhouse` `CLICKHOUSE_URL`, `CLICKHOUSE_ADMIN_USER`, `CLICKHOUSE_ADMIN_PASSWORD`, the writer, reader and
  purge users. See [configuration](configuration.md#audit-store-provisioning-migrate-step-only).
- **Output:** JSON; the last line is `audit store migrations complete` with the driver, number of applied
  migrations, the writer and whether the role was provisioned.
- **Exit codes:** `0` success, `1` any failure (including an unknown driver).

## audit-verify

Re-verifies the audit store's hash chain, every record hash and every checkpoint signature in a range, against the
store `AUDIT_DRIVER` selects. Reader credentials are enough; it only reads. There is no entry cap.

```bash
docker compose run --rm migrate node audit-store/dist/bin/audit-verify.js --from 1
docker compose run --rm migrate node audit-store/dist/bin/audit-verify.js --from 1200 --to 1350 --public-key /path/audit.pub.pem
```

| Flag | Default | Meaning |
|---|---|---|
| `--from N` | start of the store | First position (integer ≥ 1). |
| `--to N` | the head | Last position (integer ≥ 1, not below `--from`). |
| `--public-key FILE` | see below | A trusted SPKI PEM public key; several per file allowed; repeat the flag for more files. |
| `--max-unsigned N` | `5000` | Fail when more than N entries follow the last valid checkpoint (checked only when `--to` is not given). |
| `--help` | | Print usage and exit 0. |

Trusted keys: every `--public-key` file if given; otherwise the public half of `AUDIT_SIGNING_KEY` /
`AUDIT_SIGNING_KEY_FILE` plus `AUDIT_TRUSTED_PUBLIC_KEYS` / `AUDIT_TRUSTED_PUBLIC_KEYS_FILE`. An auditor should pin
keys they obtained themselves (`GET /v1/audit/keys`, or their own records), never a key an export carries.

It prints a JSON report (`ok`, `problems` with position and kind, `head`, `unsealedBacklog`, the key ids used).

| Exit code | Meaning |
|---|---|
| `0` | The range verified. |
| `1` | Problems: the chain or a record does not verify, no valid checkpoint signs the range, too many unsigned entries follow the last checkpoint, the report was truncated, or the store holds records but nothing was ever sealed (is the worker's audit-seal task running?). |
| `2` | Usage error, bad configuration, no trusted key, or the store could not be reached. |

The web app offers the same check as **Full check** on the System screen (`POST /v1/audit/verify`, permission
`audit.verify`). See [audit](../concepts/audit.md) and [backups and restore](../operations/backups-and-restore.md).

## Demo seed

Seeds the Meridian Bank demo: five users (one Tech, two Heads, two Service; no Lead), teams, agents, queues,
routing, a web chat channel and the demo MCP server connection. It uses the development-only scripted model provider, so it needs no provider keys.

```bash
# Compose
OCSO_DEMO_SEED=true docker compose --profile demo up -d

# From source, on a migrated database with the api's environment
OCSO_DEMO_SEED=true OCSO_ENABLE_DEV_PROVIDERS=true pnpm --filter @ocso/api seed
```

- **Arguments:** none.
- **Environment:** the full api configuration (`DATABASE_URL`, secrets, blob, audit store settings), plus
  `OCSO_DEMO_SEED=true` (otherwise it prints `seed: OCSO_DEMO_SEED is not "true" — nothing to do` and exits 0),
  `OCSO_ENABLE_DEV_PROVIDERS=true` (required), `OCSO_DEMO_PASSWORD` (default `meridian-demo-2026`, at least 12
  characters), `MCP_DEMO_URL` and `DEMO_MCP_TOKEN` (the demo MCP server; skipped when unset), and `OCSO_PLUGINS`
  (it loads the same plugins as the api and worker).
- **Idempotent:** a completed seed leaves an audit marker; later runs print `Meridian Bank demo is already seeded.`
  An interrupted run can be repeated. A session-level advisory lock serializes concurrent runs.
- **Output:** the demo sign-ins (the password is printed only when it is the documented default).
- **Exit codes:** `0` done or skipped, `1` failed.

> [!WARNING]
> The demo enables the scripted development provider in a production-mode container
> (`OCSO_ALLOW_DEV_PROVIDERS_IN_PRODUCTION` follows `OCSO_DEMO_SEED` in Compose). Do not run it on a deployment
> that serves real customers.

## keygen (Compose)

[`infra/compose/keygen.mjs`](../../infra/compose/keygen.mjs) runs once per `docker compose up` as the one-shot
`keygen` service (as root, no network) and exits. It creates each secret **only if it is absent** on the `secrets`
named volume, so keys survive restarts and upgrades and are never regenerated under existing data. It prints only
file names (`keygen: created …` or `keygen: kept …`).

| File on the volume | Contents |
|---|---|
| `postgres/db_password` | Main database password (root, 0400) |
| `app/database_url` | `postgres://ocso:<password>@postgres:5432/ocso` |
| `app/master_key` | Secrets master key (32 random bytes, base64). **Back it up.** |
| `app/blob_signing_key` | HMAC key for local signed blob URLs |
| `app/setup_token` | First-run `/setup` token |
| `app/better_auth_secret` | Better Auth secret. Rotating it signs everyone out. |
| `app/demo_mcp_token`, `demo/demo_mcp_token` | Bearer token of the demo MCP server |
| `app/aws_credentials`, `seaweedfs/s3.json` | SeaweedFS S3 credentials (`s3` profile) |
| `audit-postgres/db_password` | Audit database owner password |
| `audit-migrate/audit_owner_url`, `audit_writer_password`, `audit_reader_password`, `audit_writer_url`, `audit_reader_url` | Audit store provisioning (migrate step only) |
| `audit-writer/audit_database_url` | Writer connection (INSERT/SELECT only), mounted by the worker alone |
| `app/audit_reader_url` | Reader connection (SELECT only), used by the api and the seed |
| `app/audit_signing_key` | Ed25519 private key (PKCS#8 PEM) that signs audit checkpoints. **Back it up.** |

Files are owned by uid 1000 (the `node` user of the images) with mode 0400, except the two PostgreSQL passwords
(root). `KEYGEN_DIR` overrides the root folder (default `/secrets`).

> [!IMPORTANT]
> Restore the `secrets` volume before PostgreSQL starts for the first time after a restore. Otherwise `keygen`
> creates new keys that do not match the restored data. See [backups and restore](../operations/backups-and-restore.md).

## `capabilities:generate` and `capabilities:check`

Regenerate the Ask OCSO capability catalog
(`packages/internal-agent/src/catalog/capabilities.generated.json`) from the api's controllers, or check that the
committed file is current.

```bash
pnpm capabilities:generate   # writes the file if it changed; prints "N capabilities (…), M routes excluded"
pnpm capabilities:check      # exit 1 with "… is stale: run `pnpm capabilities:generate` and commit the result."
```

- **Flags:** `--check` (what `capabilities:check` passes). `DEBUG=1` prints a stack trace on extraction errors.
- **Exit codes:** `0` written, unchanged or current; `1` stale (with `--check`) or extraction failed.
- Needs `pnpm install`; no build and no database. `pnpm test` runs the same staleness check.

See [HTTP API: the capability catalog](http-api.md#the-capability-catalog).

## `pnpm evals:ask-ocso`

Runs the Ask OCSO evaluation suite ([`packages/internal-agent/evals`](../../packages/internal-agent/evals/README.md))
against a throwaway OCSO on the local PostgreSQL, through Vitest.

```bash
pnpm evals:ask-ocso --profile replay                       # scripted replay (CI): checks the plumbing, no model
pnpm evals:ask-ocso --profile <model profile uuid> --only tech.,head.checker-approve
```

| Flag | Default | Meaning |
|---|---|---|
| `--profile <uuid \| replay>` | required | A model profile of the deployment in `--source-db`, or `replay`. Its provider's credentials are read through that deployment's secret store (its `OCSO_SECRETS_MASTER_KEY` or `SECRETS_*` settings). |
| `--only <ids>` | all | Comma-separated scenario ids or prefixes. |
| `--source-db <url>` | `OCSO_EVAL_SOURCE_DATABASE_URL`, else `DATABASE_URL` (environment or the repo's `.env`) | The deployment database to read the profile from. |
| `--out <dir>` | `packages/internal-agent/evals/results` | Where the Markdown and JSON report goes. |
| `--no-gate` | gate on | Report only; do not fail below the targets (100% safety, at least 90% task success). |
| `--help`, `-h` | | Usage. |

Exit codes: `2` usage error; otherwise Vitest's exit code (non-zero when the gate fails).

## refresh-model-catalog.mjs

Regenerates the vendored model catalog snapshot (`packages/model-providers/catalog/vendored-snapshot.json`,
ADR-027) that OCSO uses offline before its first successful catalog refresh, and always when
`OCSO_MODEL_CATALOG_REFRESH=false`.

```bash
npx turbo run build --filter=@ocso/model-providers
node scripts/refresh-model-catalog.mjs
```

- **Arguments:** none. Not wired to a `pnpm` script.
- **Environment:** `MODELS_DEV_FILE`, `LITELLM_FILE`: use local copies of the models.dev and LiteLLM catalogs
  instead of downloading them.
- **Exit codes:** `1` when `@ocso/model-providers` is not built; a download failure throws.
- Review the diff before committing: prices change here.

## `pnpm test:chaos` and `pnpm test:load`

Resilience tests in [`tests/resilience`](../../tests/resilience). Both start a throwaway local stack (fresh
database, the built api and workers) unless pointed elsewhere. Build first:
`npx turbo run build --filter=@ocso/api... --filter=@ocso/worker...`. `RES_PG_URL` (default
`postgres://localhost:5432`) and `RES_DB_POOL` (default `10`) configure the stack. See
[resilience testing](../operations/resilience-testing.md).

**`pnpm test:chaos`** (`chaos-worker-kill.mjs`): kills a worker with SIGKILL and drains another with SIGTERM while
turns are in flight, and checks that every customer message gets exactly one AI reply.

| Flag | Default | Meaning |
|---|---|---|
| `--conversations N` | `20` | Concurrent conversations per scenario. |
| `--latency MS` | `3000` | Scripted model latency, so turns are mid-flight when a worker dies. |

**`pnpm test:load`** (`load-webchat.mjs`): many concurrent web chat customers; reports reply latency percentiles,
throughput and errors.

| Flag | Default | Meaning |
|---|---|---|
| `--conversations N` | `50` | Concurrent customers. |
| `--messages N` | `3` | Messages per customer. |
| `--workers N` | `2` | Workers in the local stack. |
| `--latency MS` | `800` | Scripted model latency. |
| `--per-worker N` | `25` | Conversations per worker setting. |
| `--reply-timeout S` | `60` | Seconds to wait for each reply. |
| `--base-url URL` | local stack | Run against a deployment's public web chat API instead. |
| `--key KEY` | | Web chat channel publishable key (required with `--base-url`). |

`test:load` exits `1` when there were errors or duplicate replies. Pass flags after `--`, for example
`pnpm test:load -- --conversations 100`.

## `pnpm lint`

Runs [`scripts/check-source-guards.mjs`](../../scripts/check-source-guards.mjs) over the `src/` trees of `apps/*`,
`packages/*` and `examples/*` (the package root for a workspace without `src/`, minus tests and tool configs):

1. **File size:** hand-written source files over 300 lines warn, over 500 fail. Tests, `migrations/`,
   `generated/` folders and files marked as generated are skipped.
2. **Import boundaries:** packages and examples never import an app; an app never imports another app;
   `@ocso/domain` imports and depends on no other `@ocso` package; relative imports never escape into another
   workspace package.
3. **No dependency cycles** between workspace packages (dependencies, devDependencies, peerDependencies).
4. **Plugin boundary** ([`scripts/plugin-boundary.mjs`](../../scripts/plugin-boundary.mjs)): core code never names
   a plugin kind or driver. Kinds are derived from the plugins in `FIRST_PARTY_PLUGINS`. A line can opt out with
   `// plugin-boundary: allow <reason>`.

```bash
pnpm lint
node scripts/check-source-guards.mjs --json            # machine-readable report
node scripts/check-source-guards.mjs --root <dir>      # another checkout
node --test scripts/test/                             # the guard script's own tests
```

Exit codes: `0` no failures (warnings allowed), `1` failures, `2` bad usage. It is plain Node with no
dependencies, so it runs before `pnpm install`. See [engineering rules](../contributing/engineering-rules.md).

## Related

- [Configuration](configuration.md)
- [Docker Compose deployment](../guides/deploy/docker-compose.md)
- [Upgrades](../operations/upgrades.md)
- [Backups and restore](../operations/backups-and-restore.md)
- [Audit](../concepts/audit.md)
- [Engineering rules](../contributing/engineering-rules.md)
