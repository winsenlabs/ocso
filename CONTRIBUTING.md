# Contributing to OCSO

Thank you for helping. This guide covers how to set up the repository, run each test layer, the rules
the code follows, and what a pull request needs. For what OCSO is, start with the [README](README.md).

- [License of contributions](#license-of-contributions)
- [Before you start](#before-you-start)
- [Prerequisites](#prerequisites)
- [Setup](#setup)
- [Running OCSO while you develop](#running-ocso-while-you-develop)
- [Tests](#tests)
- [The rules every change must follow](#the-rules-every-change-must-follow)
- [Adding a channel, model provider or other plugin](#adding-a-channel-model-provider-or-other-plugin)
- [Architecture decision records](#architecture-decision-records)
- [Commits and pull requests](#commits-and-pull-requests)
- [Where to start](#where-to-start)

## License of contributions

OCSO is licensed under the [Apache License 2.0](LICENSE). By submitting a contribution, you agree that it
is licensed under the same terms (inbound = outbound, section 5 of the license). There is no separate
contributor agreement to sign.

## Before you start

- **Small fixes** (bugs, docs, tests): open a pull request directly.
- **Larger changes** (a new feature, a change to a contract or the data model): open an issue first so
  that we can agree the approach before you write it.
- **A new channel, model provider or other plugin:** open a "New plugin proposal" issue, and read
  [docs/plugins/](docs/plugins/README.md) first.
- **Questions:** open an issue with the "Question" template.
- **Security issues:** do not open an issue. Follow [SECURITY.md](SECURITY.md).

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Node.js | 26 (`.nvmrc`) | `engines` allows 24 or later, but CI and the images use 26. `nvm use` or `fnm use` picks it up. |
| pnpm | 11.1.2 | Pinned in `packageManager`. `corepack enable` installs the right version. |
| PostgreSQL | 18 | For integration and browser tests. Docker is the easiest way to get it (below). |
| Docker | Engine 26+, Compose v2.30+ | For the full stack, the images, and throwaway PostgreSQL and ClickHouse servers. |
| `psql` | any recent | On your `PATH`, for the Playwright tests. |

## Setup

```bash
git clone https://github.com/winsenlabs/ocso.git && cd ocso
corepack enable
pnpm install
pnpm build                 # every package and app (turbo)
pnpm lint && pnpm typecheck && pnpm test
```

If these pass, your setup is good. A throwaway PostgreSQL for the integration tests:

```bash
docker run -d --name ocso-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:18
export OCSO_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres
pnpm test:int
```

## Running OCSO while you develop

**The quickest way to see the whole product** is the Compose demo from the README
([Quickstart](README.md#quickstart-the-demo-in-a-few-minutes)). It seeds users, agents, queues and an
MCP server, with no provider keys. Rebuild after a change with `docker compose up -d --build <service>`.

**From source.** There is no single `pnpm dev` for the whole stack yet. The pieces are:

```bash
cp .env.example .env              # then set DATABASE_URL and the other variables you need
pnpm build
DATABASE_URL=… node packages/db/dist/bin/migrate.js   # apply migrations
pnpm --filter @ocso/api dev       # api with watch; reads the repo-root .env
pnpm --filter @ocso/worker start  # worker; export the same variables first (set -a; . ./.env; set +a)
pnpm --filter @ocso/web dev       # Next.js on http://localhost:3000
```

`apps/web/e2e/stack/start-api.mjs` shows the minimal environment the api and the worker need, and
`packages/config/src/env.ts` is the full, validated list. For a demo dataset from source, set
`OCSO_DEMO_SEED=true` and run `pnpm --filter @ocso/api seed` on a fresh database.

Most day-to-day work does not need a running stack: the unit and integration tests exercise the
services directly, and the Playwright tests start their own stack.

## Tests

| Layer | Where | Run |
|---|---|---|
| Unit | `packages/*/test/**/*.test.ts`, `apps/*/test/unit/**` | `pnpm test` |
| Integration (real PostgreSQL) | `**/*.int.test.ts` | `pnpm test:int` |
| Integration (ClickHouse audit store) | `packages/audit-store/test/clickhouse-store.int.test.ts` | `pnpm test:int` with `CLICKHOUSE_TEST_URL` set |
| Browser (Playwright) | `apps/web/e2e/*.spec.ts` | one spec at a time, below |
| Resilience | `tests/resilience/` | `pnpm test:chaos`, `pnpm test:load` |
| Source guard script | `scripts/test/` | `node --test scripts/test/` |
| Ask OCSO evals | `packages/internal-agent/evals/` | `pnpm evals:ask-ocso` (see its README) |

**Unit tests** run in seconds and need nothing else. Run one file or one test:

```bash
pnpm exec vitest run --project unit packages/channels/test/twilio-send.test.ts
pnpm exec vitest run --project unit packages/domain -t "<test name>"
```

**Integration tests** run against source (no build needed). Each test file creates and drops its own
database on the server in `OCSO_TEST_DATABASE_URL` (default `postgres://localhost:5432/postgres`), so
files run in parallel and never share state.

```bash
pnpm exec vitest run --project integration packages/application/test/approvals/spine.int.test.ts
```

**ClickHouse.** The ClickHouse audit-store tests are skipped unless `CLICKHOUSE_TEST_URL` is set:

```bash
docker run -d --rm --name ocso-ch -p 8123:8123 -e CLICKHOUSE_USER=admin -e CLICKHOUSE_PASSWORD=adminpw \
  -e CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1 clickhouse/clickhouse-server:26.9
CLICKHOUSE_TEST_URL=http://admin:adminpw@localhost:8123 \
  pnpm exec vitest run --project integration packages/audit-store/test/clickhouse-store.int.test.ts
```

**Browser tests (Playwright)** start a throwaway stack for each run: a fresh database, the built api
and worker, and a production build of the web app. The full suite is long, so run the spec you
touched, one at a time:

```bash
pnpm turbo run build --filter=@ocso/api... --filter=@ocso/worker...
pnpm --filter @ocso/web exec playwright install chromium
export E2E_PG_URL=postgres://postgres:postgres@localhost:5432
pnpm --filter @ocso/web exec playwright test e2e/webchat.spec.ts
pnpm --filter @ocso/web exec playwright test e2e/workspace.spec.ts -g "<test title>"
```

`E2E_VERBOSE=1` streams the server logs. `E2E_KEEP_DB=1` keeps the database after the run. Rebuild the
api and worker after changing them; the stack runs their `dist/`.

**What to test** (build rule §23): domain behaviour, permission boundaries, adapter contracts (reuse the
shared contract suites for channels and model providers), failure and retry paths, concurrency and
idempotency, and handoff. Provider and channel tests run offline against recorded provider-format
responses through an injected `fetch`. Never call a live API from a test.

## The rules every change must follow

[docs/99-BUILD-RULES.md](docs/99-BUILD-RULES.md) is the full list. These are the ones that come up in
almost every review.

### 1. The plugin boundary: core never names a plugin kind

Channels, model providers, alert destinations, email and infrastructure drivers are plugins behind
contracts, looked up in registries by kind (ADR-028). Core code must never `switch` or `if` on a kind
such as `SLACK`, `TWILIO_WHATSAPP` or `ANTHROPIC`, and must never import a plugin's module directly.
When the core needs something kind-specific, add a method or a capability to the contract and
implement it in each plugin. `pnpm lint` (`scripts/plugin-boundary.mjs`) fails the build if core code
names a kind. Seeds, tests and fixtures are exempt. If the web app needs a label, form or icon, it comes
from the plugin's descriptor through the `/kinds` endpoints.

### 2. Migrations are hand-written

The schema is Drizzle (`packages/db/src/schema/*.ts`), but the migrations under
`packages/db/migrations/` are **written by hand** and applied by OCSO's own runner (ADR-004). **Never run
`drizzle-kit generate` against `packages/db/migrations/`.** It would write SQL that the maintainers did
not review, and it cannot express the triggers, check constraints and backfills that most of our
migrations need.

To add a migration:

1. Change the schema in `packages/db/src/schema/` so that the TypeScript types match.
2. Write `packages/db/migrations/NNNN_short_name.sql` by hand, numbered after the last one. Start it
   with a comment that says what it does and why, followed by `Hand-written; never run drizzle-kit generate.`
3. Refresh the Drizzle metadata (the journal and the snapshot). Generate into a scratch copy, then keep
   only the metadata:

   ```bash
   cd packages/db
   rm -rf .meta-refresh && cp -R migrations .meta-refresh
   pnpm exec drizzle-kit generate --dialect postgresql --schema ./src/schema/index.ts \
     --casing snake_case --out .meta-refresh --name short_name
   cp .meta-refresh/meta/_journal.json .meta-refresh/meta/NNNN_snapshot.json migrations/meta/
   diff .meta-refresh/NNNN_short_name.sql migrations/NNNN_short_name.sql   # a cross-check; keep yours
   rm -rf .meta-refresh
   ```

   Running the same `generate` command again should then print "No schema changes". If it proposes
   changes, your schema and your SQL disagree. `--out` must be a relative path.
4. Add an integration test for anything beyond a plain `CREATE TABLE`, especially backfills.
5. Commit the `.sql` file together with the updated `migrations/meta/` files.

Rules:

- **Never edit a committed migration.** The runner stores a checksum of every applied file and refuses
  to start if one changed. Fix forward with a new migration.
- **Expand, then contract.** A release only adds schema that the previous release still works with.
  Drop or rename in a later release. There are no down-migrations; rollback means restoring a backup.
- Migrations run only in the explicit `migrate` step (the Compose one-shot service), never when the api
  or the worker starts.

### 3. Configuration changes go through maker–checker and are audited

Every change to live configuration is a proposal that a second person approves (ADR-030). If you add a
new kind of configuration object (anything a Head, Lead or Tech sets up that changes how OCSO behaves):

- Register an `ApprovalDescriptor` for it (`packages/application/src/approvals/contract.ts`; the existing
  ones such as `packages/application/src/agents/approval.ts` are the pattern) and add it to
  `approvals/composition.ts`. `packages/application/test/approvals/coverage.test.ts` fails until the
  descriptor is registered and the kind is on the reviewed list.
- Stops (pause, disable, revoke) apply immediately and are not proposals. Everything else waits for a
  checker.
- Every privileged write calls `recordAudit` in the **same transaction** as the change, with a `before`
  and `after` that contain no secrets. The audit outbox ships it to the audit store.
- New permissions go in the catalogue in `packages/auth`, with a description, and into the presets that
  should hold them.
- Every new api route declares its access rule (`@RequirePermission` and friends).
  `apps/api/test/unit/route-access.test.ts` fails if a route has none.

### 4. The Ask OCSO capability catalog

Ask OCSO's tools are generated from the API's `@Capability` decorators into
`packages/internal-agent/src/catalog/capabilities.generated.json` (ADR-035). When you add or change an
api route, run:

```bash
pnpm capabilities:generate
```

and commit the result. `pnpm test` fails when the committed catalog is stale (`pnpm capabilities:check`
shows the same thing).

### 5. File size and the source guards

`pnpm lint` runs `scripts/check-source-guards.mjs`. It enforces:

- **File size.** A hand-written source file over 300 lines is a warning, over 500 fails. Tests,
  migrations and generated files are exempt. Split by responsibility, not into a universal `utils.ts`
  or `types.ts`.
- **Import boundaries.** Packages never import an app, apps never import each other, `@ocso/domain`
  imports no other `@ocso` package, and there are no relative imports into another package.
- **No dependency cycles** between workspace packages.
- **The plugin boundary** (rule 1).

### Other rules

- **Single tenant.** One deployment is one organization. No tenant IDs, tenant middleware or tenant
  switching.
- **PostgreSQL is the truth.** Persist before you rely on asynchronous work. A worker can die at any
  moment.
- **Authorization in code.** A prompt is never a permission. Every tool call passes a server-side check.
- **Validate at boundaries** with zod: HTTP, events, channels, providers, MCP and configuration.
- **Idempotency.** Webhooks and side effects must tolerate retries.
- **Never log secrets** in logs, traces, prompts, audit payloads, API responses or errors.
- **Code conventions** (ADR-001, ADR-003): TypeScript, ESM with `.js` import suffixes, strict with
  `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. NestJS decorators and modules exist only
  in `apps/*`; packages are plain TypeScript. Import Nest injectables as values, never with
  `import type`, or their decorator metadata is erased.

## Adding a channel, model provider or other plugin

1. Open a "New plugin proposal" issue describing the kind, what it needs from the core, and how it will
   be tested offline.
2. Read [docs/plugins/README.md](docs/plugins/README.md) and the page for your extension point:
   [channels](docs/plugins/channels.md), [model providers](docs/plugins/model-providers.md),
   [alerts](docs/plugins/alerts.md), [email](docs/plugins/email.md),
   [infrastructure drivers](docs/plugins/infrastructure-drivers.md).
3. For a channel, follow [add a channel in seven steps](docs/plugins/add-a-channel.md). The Slack and
   Microsoft Teams channels ([slack.md](docs/plugins/slack.md), [ms-teams.md](docs/plugins/ms-teams.md))
   are recent, complete examples.
4. A plugin that lives outside this repository builds on `packages/ocso-plugin-sdk` and is loaded with
   `OCSO_PLUGINS` ([installing plugins](docs/plugins/installing.md)).
   `examples/ocso-plugin-example-channel` is a working example.
5. Register a first-party plugin with one entry in `FIRST_PARTY_PLUGINS`
   (`packages/bootstrap/src/first-party.ts`). Nothing in the core, the database or the web app should
   need to change. If it does, that is a boundary leak: say so in the PR.

MCP tool servers and SSO identity providers need no code: they are added in the web app.

## Architecture decision records

Decisions live in [PM/ARCHITECTURE-DECISIONS.md](PM/ARCHITECTURE-DECISIONS.md). Write a new ADR when you:

- change a contract, a boundary between packages or apps, or the data model in a way others must follow;
- add a dependency that shapes the architecture;
- deviate from a rule or from the spec in `docs/`.

Records are append-only. Use the next number, the status `PROPOSED` until the change is reviewed, and
the same sections as the existing records: Decision, Why, Alternatives, Consequences and Spec impact. A
replaced decision is marked `SUPERSEDED by ADR-NNN`, not deleted. Update the affected docs in the same
change.

## Commits and pull requests

- **One concern per pull request.** A vertical slice (schema, service, API, UI, tests) is better than
  one layer at a time.
- **Commit messages:** one plain summary line saying what changed, in the style of the existing history
  (for example "Slack and Microsoft Teams channels; Ask OCSO in Slack/Teams with account linking"), then
  a body explaining why if it is not obvious.
- **The pull request** says what changed, why, and how you tested it, with screenshots for UI changes.
  The PR template has the checklist.
- **CI** runs the source guards, typecheck, unit and integration tests (PostgreSQL and ClickHouse), the
  web build, the Docker image builds, `docker compose config` and Terraform validation. The Playwright
  job runs on every pull request but does not block merges yet; run the specs you touched locally.
- **Never commit** secrets, `.env` files, database dumps or real customer data, including in fixtures.
- **Docs.** Operator-facing changes update `docs/operations/`. Behaviour that refines the spec updates
  the "Implementation notes (as built)" section of the relevant `docs/NN-*.md`. Plugin changes update
  `docs/plugins/`.

## Where to start

- Read [docs/00-INDEX.md](docs/00-INDEX.md), then [docs/plugins/README.md](docs/plugins/README.md) and
  [docs/99-BUILD-RULES.md](docs/99-BUILD-RULES.md).
- Run the demo and click through it as each role.
- Pick an item from [ROADMAP.md](ROADMAP.md). The "Good first issues" section lists self-contained
  pieces of work, and issues labelled `good first issue` are the same kind of thing.
- `pnpm lint` prints the files over 300 lines. Splitting one of them cleanly is a useful first PR.

## Code of conduct

Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
