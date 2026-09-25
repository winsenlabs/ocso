# Configuration reference

Every environment variable OCSO reads, grouped by area. This page is for operators who deploy OCSO and for
contributors who add a setting. Deployment-level configuration lives in the environment only; business
configuration (agents, channels, providers, routing) lives in the database and is changed in the web app under
maker–checker.

The validated schemas are in [`packages/config/src/env.ts`](../../packages/config/src/env.ts): `ApiEnv` (the api),
`WorkerEnv` (the worker) and `AuditToolsEnv` (the `audit-migrate` and `audit-verify` tools). A few settings are read
from the raw environment instead, because `loadEnv` drops keys a schema does not declare; those are marked
**raw** below.

> [!NOTE]
> An invalid value stops the process at start-up with `Invalid OCSO configuration:` and one line per problem.
> Values of secret-looking settings (names containing `KEY`, `SECRET`, `TOKEN`, `PASSWORD`, `DATABASE_URL`,
> `SMTP_URL`, `CLICKHOUSE_URL`) are never echoed in that message.

**How to read the tables**

- **Process**: `api`, `worker`, `both` (api and worker), `web` (the Next.js app), `migrate` (the migrate image:
  `migrate.js`, `audit-migrate`, `audit-verify`), `seed` (the demo seed).
- **Prod**: `required` means start-up fails in production without it. `when …` means it is required only in that
  case. An empty cell means optional.
- Booleans accept `true`, `false`, `1` and `0` unless noted. Compose passes unset settings as empty strings;
  for settings that use the schema's `blank()` wrapper an empty string counts as unset.

## Core

| Variable | Process | Default | Prod | Description |
|---|---|---|---|---|
| `NODE_ENV` | both | `development` | | `development`, `test` or `production`. The server images set `production`. Several guards below apply only in production. |
| `LOG_LEVEL` | both | `info` | | `trace`, `debug`, `info`, `warn`, `error` or `fatal`. |
| `APP_VERSION` | both | `dev` | | Version string in logs, telemetry and **System → Plugins**. The images bake it from the `APP_VERSION` build argument. |
| `PORT` | api | `4000` | | HTTP port of the api. The web image also reads `PORT` (default `3000`). |
| `HEALTH_PORT` | worker | `4100` | | Port of the worker's `/health/live` and `/health/ready`. |
| `OCSO_PUBLIC_URL` | both, web | `http://localhost:3000` | set it | Public origin that customers, channel providers (webhooks), OAuth callbacks and signed blob links use. Set it to your real `https://` origin for anything beyond localhost. |
| `TRUST_PROXY` | api | `true` | | Express `trust proxy`: `true` (every hop), `false`/`0`, or a hop count such as `1` behind one load balancer. Compose sets `true` because only the web app talks to the api. |

## Database

| Variable | Process | Default | Prod | Description |
|---|---|---|---|---|
| `DATABASE_URL` | both, migrate, seed | none | required | PostgreSQL connection URL of the main database. Required in every environment. |
| `DATABASE_SSL` | both, migrate | `false` | | TLS to PostgreSQL with certificate verification. On AWS set `NODE_EXTRA_CA_CERTS=/etc/ssl/certs/rds-global-bundle.pem` (the images ship the RDS bundle). |
| `DATABASE_POOL_SIZE` | both | `10` | | Connections per process (1–200). Keep `DATABASE_POOL_SIZE × (api + workers)` below PostgreSQL `max_connections`. |
| `OCSO_MIGRATIONS_DIR` | migrate (**raw**) | the package's `migrations/` | | Override where `migrate.js` reads SQL files from. Normally unset. |

## Authentication and sessions

All of these are read by the api only. Sign-in methods themselves (SSO providers, passkeys, MFA policy) are
configured in the web app, not here.

| Variable | Default | Prod | Description |
|---|---|---|---|
| `BETTER_AUTH_SECRET` | none | required | At least 32 characters. Signs session cookies and encrypts TOTP secrets and backup codes. Compose `keygen` generates it. Changing it signs everyone out and makes enrolled authenticator apps unusable. |
| `OCSO_SETUP_TOKEN` | generated | | One-time token the first-run `/setup` page asks for (at least 16 characters). If unset, the api generates one and logs it: `First-run setup required. Open /setup in the web UI and use setup token: …`. |
| `SESSION_IDLE_MINUTES` | `120` | | Idle session lifetime (minimum 5). |
| `SESSION_ABSOLUTE_HOURS` | `24` | | Absolute session lifetime (minimum 1). |
| `SESSION_COOKIE_SECURE` | `true` when `OCSO_PUBLIC_URL` is `https` | | `Secure` session cookies (`__Secure-` prefix). Compose defaults it to `true`; set `false` only for a plain-http trial on a host other than localhost. |
| `SESSION_STREAM_RECHECK_SECONDS` | `60` | | How often long-lived streams (staff SSE, Ask OCSO) re-check their session (1–300). They close when the session has ended. |
| `OCSO_AUTH_TRUSTED_ORIGINS` | none | | Extra origins Better Auth trusts, comma-separated `http(s)` origins, for example an OIDC identity provider on a private network. |
| `OCSO_AUTH_RATE_LIMIT` | on | | Better Auth's database-backed rate limiter. Turn it off only for load tests. |
| `OCSO_RECOVERY_TOKEN` | none | | Break-glass: while set (at least 32 characters), `/recover` resets one Tech user's password. Each value works once. Set it, restart the api, use it, remove it. |

## Audit store

The audit store is a separate database that is the system of record for audit events (ADR-032). The worker writes
to it with INSERT/SELECT-only credentials; the api and the demo seed read with SELECT-only credentials where the
deployment provisions a reader. See [audit](../concepts/audit.md).

| Variable | Process | Default | Prod | Description |
|---|---|---|---|---|
| `AUDIT_DRIVER` | both, migrate | `postgres` | | A registered audit store driver. First party: `postgres`, `clickhouse`. |
| `AUDIT_DATABASE_URL` | both, migrate | none | when `AUDIT_DRIVER=postgres` | Connection to the audit database: the writer (worker) or the reader (api, seed). |
| `AUDIT_DATABASE_URL_FILE` | both, migrate | none | | File holding `AUDIT_DATABASE_URL`. A non-empty `AUDIT_DATABASE_URL` wins. |
| `AUDIT_DATABASE_SSL` | both, migrate | unset (off) | | TLS to the audit database. |
| `AUDIT_DATABASE_POOL_SIZE` | both | `5` | | Connections to the audit database (1–100). |
| `CLICKHOUSE_URL` | both, migrate | none | when `AUDIT_DRIVER=clickhouse` | ClickHouse HTTP interface, for example `http://clickhouse:8123`. |
| `CLICKHOUSE_DATABASE` | both, migrate | `ocso_audit` | | ClickHouse database name. |
| `CLICKHOUSE_USER` | both, migrate | none | when `AUDIT_DRIVER=clickhouse` | The writer user (SELECT, INSERT) for the worker; the read-only user for the api. |
| `CLICKHOUSE_PASSWORD` / `CLICKHOUSE_PASSWORD_FILE` | both, migrate | none | | Password of `CLICKHOUSE_USER`, inline or from a file. |
| `CLICKHOUSE_PURGE_USER` | worker | none | | User allowed to drop months past retention (needs ALTER DELETE, which the writer never holds). Unset: the worker never purges. |
| `CLICKHOUSE_PURGE_PASSWORD` / `CLICKHOUSE_PURGE_PASSWORD_FILE` | worker | none | | Password of the purge user. |
| `AUDIT_STORE_TIMEOUT_MS` | both | `15000` | | Bound on one audit store call (1000–300000 ms), so a store that stops answering fails fast. |
| `AUDIT_SIGNING_KEY_FILE` | both, migrate | none | required (or `AUDIT_SIGNING_KEY`) | Ed25519 private key (PKCS#8 PEM) that signs audit checkpoints, exports and exception reports. Compose `keygen` generates it. Back it up. Outside production an unset key falls back to a development key, with a warning. |
| `AUDIT_SIGNING_KEY` | both, migrate | none | | The same key inline (for ECS, which injects secrets as variables). Wins over the file. Literal `\n` sequences are turned into newlines. |
| `AUDIT_TRUSTED_PUBLIC_KEYS_FILE` | both, migrate | none | | Retired signing keys' public halves (concatenated SPKI PEM blocks), so older checkpoints and exports still verify after a key rotation. |
| `AUDIT_TRUSTED_PUBLIC_KEYS` | both, migrate | none | | The same bundle inline. Used together with the file when both are set. |

### Audit store provisioning (migrate step only)

These are in `AuditToolsEnv` and are read only by `audit-migrate` and `audit-verify` (see [CLI](cli.md)). The api and
the worker never hold owner credentials.

| Variable | Default | Description |
|---|---|---|
| `AUDIT_DATABASE_OWNER_URL` / `AUDIT_DATABASE_OWNER_URL_FILE` | none | Owner connection (postgres driver): creates tables, functions and the writer role. |
| `AUDIT_WRITER_PASSWORD` / `AUDIT_WRITER_PASSWORD_FILE` | the password in `AUDIT_DATABASE_URL` | Password set on the writer role (8–1024 characters). |
| `AUDIT_READER_URL` / `AUDIT_READER_URL_FILE` | none | The api's read-only connection (postgres driver); its user becomes the SELECT-only reader role. |
| `AUDIT_READER_PASSWORD` / `AUDIT_READER_PASSWORD_FILE` | the password in `AUDIT_READER_URL` | Password set on the reader role or user. |
| `CLICKHOUSE_READER_USER` | none | The api's read-only ClickHouse user (clickhouse driver). |
| `CLICKHOUSE_ADMIN_USER` | none | ClickHouse user allowed to create the database, tables and the writer user. |
| `CLICKHOUSE_ADMIN_PASSWORD` / `CLICKHOUSE_ADMIN_PASSWORD_FILE` | none | Its password. |
| `AUDIT_PROVISION_ROLE` | `true` | `false` when a DBA created the writer role/user (managed databases): only grants are applied. |
| `AUDIT_MIN_RETENTION_DAYS` | `365` | The store's own minimum retention (365–36500). No purge removes anything younger, whatever the writer asks. |
| `AUDIT_ALLOW_OWNER_WRITER` | `false` | Production refuses a writer that is the owner or an admin (append-only would not be enforced) unless this is `true`. |

## Secrets

| Variable | Process | Default | Prod | Description |
|---|---|---|---|---|
| `SECRETS_DRIVER` | both | `local` | | A registered secrets driver. First party: `local` (AES-256-GCM envelope encryption in PostgreSQL) and `aws` (AWS Secrets Manager; PostgreSQL keeps metadata and the ARN). |
| `OCSO_SECRETS_MASTER_KEY` | both | none | when `SECRETS_DRIVER=local` (or the file) | Base64-encoded 32-byte master key. |
| `OCSO_SECRETS_MASTER_KEY_FILE` | both | none | | File holding the master key. The app reads it itself, so the key never enters the process environment. Compose `keygen` generates it. Back it up: without it, stored credentials cannot be decrypted. |
| `SECRETS_NAME_PREFIX` | both | `ocso` | | Name prefix for secrets the `aws` driver creates. |

## Blob storage

| Variable | Process | Default | Prod | Description |
|---|---|---|---|---|
| `BLOB_DRIVER` | both | `local` | | A registered blob driver. First party: `local` (filesystem; signed links served by the api's `/blobs` route) and `s3` (S3 or S3-compatible; presigned links). |
| `BLOB_LOCAL_DIR` | both | `./data/blobs` | | Directory for the `local` driver. The server images set `/var/lib/ocso/blobs`. |
| `BLOB_SIGNING_KEY` | both | none | when `BLOB_DRIVER=local` | HMAC key for local signed blob URLs (at least 16 characters). Compose `keygen` generates it. |
| `S3_BUCKET` | both | none | when `BLOB_DRIVER=s3` | Bucket name. |
| `S3_ENDPOINT` | both | none | | Endpoint URL for an S3-compatible store (for example SeaweedFS in the Compose `s3` profile). |
| `S3_KMS_KEY_ID` | both | none | | KMS key for server-side encryption. |
| `AWS_REGION` | both | `us-east-1` for S3 | when `QUEUE_DRIVER=sqs` | AWS region for the S3, SQS, Secrets Manager and ECS clients. |

## Queue

| Variable | Process | Default | Prod | Description |
|---|---|---|---|---|
| `QUEUE_DRIVER` | both | `postgres` | | A registered queue driver. First party: `postgres` (a `jobs` table with `SKIP LOCKED` and conversation affinity) and `sqs` (SQS Standard, one queue per topic). |
| `SQS_QUEUE_URLS` | both | none | when `QUEUE_DRIVER=sqs` | `topic=url` pairs separated by commas. |

## Email

Transactional email (invites, password resets, sign-in codes, alert emails). Configured only in the environment;
**Settings → Email** in the web app shows the status and sends a test. The cross-field rules live in
`resolveEmailConfig` in [`packages/email`](../../packages/email/src/config.ts), which the api and the worker run
at start-up. See [email](../guides/email.md).

| Variable | Process | Default | Prod | Description |
|---|---|---|---|---|
| `EMAIL_DRIVER` | both | `log` outside production | required (unless `EMAIL_ALLOW_LOG_IN_PRODUCTION=true`) | A registered email driver. First party: `resend`, `smtp`, `log` (writes messages to the log; delivers nothing). Installed plugins can add more. |
| `EMAIL_FROM` | both | none | | Sender, for example `Acme Support <support@mail.acme.example>`, on a domain your provider has verified. |
| `EMAIL_REPLY_TO` | both | none | | Reply-to address. |
| `EMAIL_ALLOW_LOG_IN_PRODUCTION` | both | unset | | Accept the `log` driver (or no driver) in production. Trials only: nobody receives invites or resets. |
| `RESEND_API_KEY` / `RESEND_API_KEY_FILE` | both | none | when `EMAIL_DRIVER=resend` | Resend API key, inline or from a file. |
| `SMTP_URL` | both | none | | `smtp://user:pass@host:587` or `smtps://host:465`, instead of the discrete settings below. |
| `SMTP_HOST` | both | none | | SMTP relay host. |
| `SMTP_PORT` | both | none | | SMTP port (1–65535). |
| `SMTP_SECURE` | both | `true` on port 465 | | Implicit TLS. |
| `SMTP_REQUIRE_TLS` | both | `true` | | Require STARTTLS on non-TLS ports. `false` only for a local relay such as Mailpit. |
| `SMTP_USER` | both | none | | SMTP user name. |
| `SMTP_PASSWORD` / `SMTP_PASSWORD_FILE` | both | none | | SMTP password, inline or from a file. |

## Channels, web chat and the public origin

| Variable | Process | Default | Description |
|---|---|---|---|
| `OCSO_PUBLIC_URL` | both, web | `http://localhost:3000` | See [Core](#core). Webhook URLs shown in channel setup guides are built from it. |
| `OCSO_WEBCHAT_RATE_LIMITS` | api | built-in | Overrides of the public web chat rate limits, requests per minute per api instance: `key=number` pairs, for example `session=120,messages=90`. Keys and defaults: `sessionPassFailures` 30, `session` 30 (per channel and IP), `messages` 60, `attachments` 20, `stream` 30 (per channel and visitor). `0` turns a limit off. Raise `session` when many visitors share one address. |
| `OCSO_TRUSTED_PROXY_HOPS` | web (**raw**) | `0` in Compose; `1` when unset | Number of reverse proxies in front of the web app that append `X-Forwarded-For` (for example `1` behind Caddy, nginx or an ALB). Used for per-address sign-in throttling and audit. `0` ignores the header. |
| `API_URL` | web (**raw**) | `http://localhost:4000` | Internal origin of the api. Next.js resolves rewrites at **build** time, so the web image must be built with the value it runs with (the Dockerfile's `API_URL` build argument, default `http://api:4000`). |

## Workers and deployment

| Variable | Process | Default | Prod | Description |
|---|---|---|---|---|
| `DEPLOYMENT_DRIVER` | worker | `compose` | | A registered deployment driver. First party: `compose` (replicas are operator-controlled; scaling answers with advice) and `ecs` (Application Auto Scaling, CloudWatch metrics, scale-in protection per turn). |
| `ECS_CLUSTER` | worker | none | when `DEPLOYMENT_DRIVER=ecs` | ECS cluster name. |
| `ECS_WORKER_SERVICE` | worker | none | when `DEPLOYMENT_DRIVER=ecs` | ECS service of the workers. |
| `OCSO_METRICS_NAMESPACE` | worker | `OCSO/<ECS_CLUSTER>` | | CloudWatch namespace for the scaling metrics (ADR-023). |
| `ECS_AGENT_URI` | worker | set by ECS | | Enables turn-scoped scale-in protection. Do not set it yourself. |
| `WORKER_ID` | worker | generated | | Stable worker id. Normally unset. |
| `WORKER_CAPACITY` | worker | the database setting | | Overrides the conversations-per-worker setting for local experiments. Normally unset; capacity is set in the web app. |

Worker replicas under Compose are set with `OCSO_WORKER_REPLICAS` (see [Compose-only settings](#compose-only-settings)).
See [worker scaling](../operations/worker-scaling.md).

## Observability

| Variable | Process | Default | Description |
|---|---|---|---|
| `OTEL_ENABLED` | both | `false` | Turns on the OpenTelemetry SDK (traces, metrics, logs over OTLP). |
| `OTEL_SERVICE_NAME` | both (**raw**) | `ocso-api` / `ocso-worker` (set by the images) | Service name on telemetry. |
| `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_PROTOCOL` and other `OTEL_EXPORTER_OTLP_*` | both (read by the OTel SDK) | Compose: `http://otel-collector:4318`, `http/protobuf` | Standard OpenTelemetry exporter settings. |
| `OCSO_TRACE_URL_TEMPLATE` | api | none | Deep link from telemetry screens to your trace backend. Must contain `{traceId}`, for example `http://localhost:16686/trace/{traceId}`. |

## Model providers

| Variable | Process | Default | Description |
|---|---|---|---|
| `OCSO_MODEL_CATALOG_REFRESH` | both | `true` | Download the open-source model catalogs (models.dev, LiteLLM) for prices and model metadata (ADR-027). `false` = air-gapped: the bundled snapshot is used and refresh is disabled. |
| `OCSO_ENABLE_DEV_PROVIDERS` | both | `false` | Registers development-only model providers (the scripted demo model). Refused in production unless the next variable is set. |
| `OCSO_ALLOW_DEV_PROVIDERS_IN_PRODUCTION` | both (**raw**) | unset | `true` lets `OCSO_ENABLE_DEV_PROVIDERS` run with `NODE_ENV=production`. Demos only. Compose sets both from `OCSO_DEMO_SEED`. |

Provider credentials (API keys, IAM settings) are not environment variables: they are entered in the web app and
stored in the secret store. See [models](../guides/models/README.md).

## Plugins

| Variable | Process | Default | Description |
|---|---|---|---|
| `OCSO_PLUGINS` | both, seed (**raw**) | none | Installed plugins, comma-separated `name@exactVersion` entries, for example `@acme/ocso-channel-line@1.2.3`. Ranges and tags are refused. The api and the worker must run the same list. |
| `OCSO_PLUGINS_DIR` | both, seed (**raw**) | `/app/plugins` | Folder the plugins are installed in (`<dir>/node_modules/<name>`). |

See [install a plugin](../guides/extending/install-a-plugin.md).

## Development, demo and test only

| Variable | Process | Default | Description |
|---|---|---|---|
| `OCSO_DEV_SKIP_ACCESS_APPROVAL` | api | unset | New users are created ACTIVE and preset upgrades, re-enabling and team additions apply at once instead of waiting for approval. Per-user permission grants still need approval. Refused in production, and refused unless `NODE_ENV` is set explicitly to `development` or `test`. |
| `OCSO_ENABLE_TEST_HOOKS` | api | unset | Test-only routes (for example `GET /v1/test-hooks/emails`, emails captured by the `log` driver). Refused in production. |
| `OCSO_DEMO_SEED` | seed | `false` | `true` seeds the Meridian Bank demo on a fresh database. The seed does nothing otherwise. |
| `OCSO_DEMO_PASSWORD` | seed | `meridian-demo-2026` | Password for every demo account (at least 12 characters). |
| `MCP_DEMO_URL` | seed | Compose: `http://mcp-bank-demo:8080/mcp` | URL of the demo MCP server the seed registers. |
| `DEMO_MCP_TOKEN` | seed | Compose: generated | Bearer token of the demo MCP server. |
| `OCSO_TEST_DATABASE_URL` | tests | `postgres://localhost:5432/postgres` | Server the integration tests create throwaway databases on. |
| `CLICKHOUSE_TEST_URL` | tests | unset | Enables the ClickHouse audit-store integration tests. |
| `E2E_PG_URL`, `E2E_VERBOSE`, `E2E_KEEP_DB` and other `E2E_*` | Playwright | see `apps/web/e2e/config.ts` | Playwright stack settings. |
| `RES_PG_URL`, `RES_DB_POOL` | resilience tests | `postgres://localhost:5432`, `10` | PostgreSQL server and pool size for `test:chaos` and `test:load`. |

## Compose-only settings

These are interpolated by [`compose.yaml`](../../compose.yaml) and its overlays in `infra/compose/`. The
application never reads them.

| Variable | Default | Description |
|---|---|---|
| `OCSO_HTTP_BIND` | `0.0.0.0` | Host interface the web app is published on. Use `127.0.0.1` behind the TLS overlay. |
| `OCSO_HTTP_PORT` | `3000` | Host port of the web app. |
| `OCSO_DOMAIN` | none | Domain Caddy obtains a certificate for (`infra/compose/tls.yaml`). |
| `OCSO_WEBSITE_DOMAIN`, `OCSO_SITE_URL` | none | Public website overlay (`infra/compose/website.yaml`). |
| `OCSO_IMAGE_PREFIX` | `ocso` | Image name prefix: `${OCSO_IMAGE_PREFIX}/<service>:${OCSO_VERSION}`. |
| `OCSO_VERSION` | `local` | Image tag. |
| `OCSO_POSTGRES_IMAGE` | `postgres:18.6` | Image of the `postgres` and `audit-db` services. |
| `OCSO_WORKER_REPLICAS` | `2` | Number of worker containers. |
| `OCSO_JAEGER_UI_PORT`, `OCSO_JAEGER_IMAGE`, `OCSO_OTELCOL_IMAGE` | see `compose.yaml` | Observability profile. |
| `OCSO_SEAWEEDFS_IMAGE` | see `compose.yaml` | `s3` profile. |
| `OCSO_API_DEBUG_PORT`, `OCSO_POSTGRES_DEBUG_PORT` | see `infra/compose/debug.yaml` | Debug overlay port publishing. |

## `_FILE` variants and the container entrypoint

The api, worker and migrate images run [`infra/compose/ocso-entrypoint.sh`](../../infra/compose/ocso-entrypoint.sh)
before Node starts. For each variable in the list below it resolves `<VAR>_FILE` into `<VAR>`, so Compose can hand
secrets over as files on the restricted `secrets` volume instead of plain values in `.env`:

`DATABASE_URL`, `BLOB_SIGNING_KEY`, `OCSO_SETUP_TOKEN`, `BETTER_AUTH_SECRET`, `OCSO_RECOVERY_TOKEN`,
`OCSO_DEMO_PASSWORD`, `DEMO_MCP_TOKEN`, `RESEND_API_KEY`, `SMTP_PASSWORD`, `AUDIT_DATABASE_URL`,
`AUDIT_DATABASE_OWNER_URL`, `AUDIT_READER_URL`, `AUDIT_WRITER_PASSWORD`, `AUDIT_READER_PASSWORD`,
`CLICKHOUSE_PASSWORD`, `CLICKHOUSE_ADMIN_PASSWORD`, `CLICKHOUSE_PURGE_PASSWORD`.

Rules:

- A non-empty `<VAR>` wins over `<VAR>_FILE`, so you can point at external infrastructure (for example
  `DATABASE_URL` for RDS) without editing `compose.yaml`. The `_FILE` variable is removed from the environment
  either way.
- If `<VAR>_FILE` names a missing or unreadable file, the container exits with code 66 and prints only the
  variable name, never file contents.
- On ECS the variables arrive directly from Secrets Manager and the script does nothing.

`OCSO_SECRETS_MASTER_KEY_FILE`, `AUDIT_SIGNING_KEY_FILE` and `AUDIT_TRUSTED_PUBLIC_KEYS_FILE` are deliberately not
in that list: the application reads those files itself, so the keys never enter the process environment.

> [!IMPORTANT]
> `DATABASE_URL_FILE`, `BETTER_AUTH_SECRET_FILE`, `BLOB_SIGNING_KEY_FILE`, `OCSO_SETUP_TOKEN_FILE`,
> `OCSO_RECOVERY_TOKEN_FILE`, `OCSO_DEMO_PASSWORD_FILE` and `DEMO_MCP_TOKEN_FILE` work **only** through the
> entrypoint. Outside the images (running from source) set the plain variable. The other `_FILE` settings
> (`RESEND_API_KEY_FILE`, `SMTP_PASSWORD_FILE`, the audit and ClickHouse ones) are also understood by the
> application itself.

## `.env.example` compared with the schema

[`.env.example`](../../.env.example) is the Compose settings template, not a full list. Differences found when this
page was written:

- **In `.env.example` but not read by the application:** `OCSO_DOMAIN`, `OCSO_WEBSITE_DOMAIN`, `OCSO_SITE_URL`,
  `OCSO_HTTP_BIND`, `OCSO_HTTP_PORT`, `OCSO_IMAGE_PREFIX`, `OCSO_VERSION`, `OCSO_POSTGRES_IMAGE`,
  `OCSO_WORKER_REPLICAS`, `OCSO_JAEGER_UI_PORT` (Compose interpolation only); `OTEL_EXPORTER_OTLP_ENDPOINT` (read by
  the OTel SDK); `OCSO_TRUSTED_PROXY_HOPS` (read by the web app, not `packages/config`); `OCSO_DEMO_SEED`,
  `OCSO_DEMO_PASSWORD` (demo seed only); `OCSO_ALLOW_DEV_PROVIDERS_IN_PRODUCTION` (raw environment).
- **Read by the application but absent from `.env.example`:** `QUEUE_DRIVER`, `SQS_QUEUE_URLS`, `SECRETS_DRIVER`,
  `OCSO_SECRETS_MASTER_KEY(_FILE)`, `SECRETS_NAME_PREFIX`, `BLOB_LOCAL_DIR`, `BLOB_SIGNING_KEY`, `S3_KMS_KEY_ID`,
  `DEPLOYMENT_DRIVER`, `ECS_CLUSTER`, `ECS_WORKER_SERVICE`, `OCSO_METRICS_NAMESPACE`, `WORKER_ID`,
  `WORKER_CAPACITY`, `OCSO_MODEL_CATALOG_REFRESH`, `OCSO_AUTH_RATE_LIMIT`, `SESSION_STREAM_RECHECK_SECONDS`,
  `TRUST_PROXY`, `OCSO_TRACE_URL_TEMPLATE`, `OCSO_WEBCHAT_RATE_LIMITS` (Compose passes it through),
  `OCSO_PLUGINS`, `OCSO_PLUGINS_DIR`, `SMTP_URL`, `AUDIT_SIGNING_KEY(_FILE)`, `AUDIT_TRUSTED_PUBLIC_KEYS`,
  `AUDIT_WRITER_PASSWORD`, `AUDIT_READER_PASSWORD`, `CLICKHOUSE_PURGE_*_FILE`, `OCSO_ENABLE_TEST_HOOKS`,
  `OCSO_DEV_SKIP_ACCESS_APPROVAL`. Most of these have safe defaults or are generated by `keygen`.
- The header comment of `.env.example` says `keygen` generates an "internal signing key". `keygen` generates the
  database password, the secrets master key, the blob signing key, the setup token, the Better Auth secret, the
  audit store passwords and the audit signing key; there is no separate "internal signing key".

## Related

- [Docker Compose deployment](../guides/deploy/docker-compose.md)
- [AWS deployment](../guides/deploy/aws.md)
- [Local development](../guides/deploy/local-development.md)
- [CLI and operations commands](cli.md)
- [Install a plugin](../guides/extending/install-a-plugin.md)
- [Email](../guides/email.md)
- [Audit](../concepts/audit.md)
