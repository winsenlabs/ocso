# Contributing to OCSO

Thank you for helping. This file covers how to set up the repository, the rules the code follows, and
what a pull request needs. For what OCSO is, start with the [README](README.md).

## License of contributions

OCSO is licensed under the [Apache License 2.0](LICENSE). By submitting a contribution, you agree that it
is licensed under the same terms (inbound = outbound, section 5 of the license). There is no separate
contributor agreement to sign.

## Before you start

- **Small fixes** (bugs, docs, tests): open a pull request directly.
- **Larger changes** (a new feature, a change to a contract or the data model): open an issue first so
  the approach can be agreed before you write it.
- **A new channel, model provider or other plugin:** open a "New plugin proposal" issue. Read
  [docs/plugins/](docs/plugins/README.md) first; [add-a-channel.md](docs/plugins/add-a-channel.md) shows
  the full path for a channel.
- **Security issues:** do not open an issue. Follow [SECURITY.md](SECURITY.md).

## Prerequisites

- Node.js 26 (see `.nvmrc`; `engines` allows 24 or later).
- pnpm 11.1.2, the version pinned in `packageManager` in `package.json`.
- Docker, or a local PostgreSQL 18, for integration tests.
- For browser tests: `psql` on your `PATH` and Playwright's Chromium.

## Setup

```bash
git clone https://github.com/winsenlabs/ocso.git && cd ocso
pnpm install
pnpm build
pnpm lint && pnpm typecheck && pnpm test
```

To run the whole product locally, use Docker Compose as in the README
([Quickstart](README.md#quickstart-with-docker-compose)). The demo profile gives you seeded users, agents
and an MCP server with no provider keys.

## Build rules

[docs/99-BUILD-RULES.md](docs/99-BUILD-RULES.md) is mandatory. The rules that most often come up in
review:

- **Small files (§2).** Aim for under ~300 lines. `pnpm lint` warns above 300 and fails above 500
  (tests, migrations and generated files excepted). No universal `utils.ts` or `types.ts`, no giant
  controllers or pages.
- **Single tenant (§3).** No tenant IDs, tenant middleware or tenant switching. One deployment is one
  organization.
- **Plugins at external boundaries (§4).** Providers, channels, tools, queues, storage and alert
  destinations sit behind contracts and registries. Never add a `switch` or `if` on a provider or channel
  kind in core code; add a method to the contract instead. See [docs/plugins/](docs/plugins/README.md).
- **PostgreSQL is the truth (§5).** Persist before relying on asynchronous work. A worker can die at any
  moment.
- **Authorization in code (§14).** Every route declares its access rule; every tool and control action
  passes a server-side check. A prompt is never a permission.
- **Validate at boundaries (§19).** zod schemas on HTTP, events, channels, providers, MCP and
  configuration.
- **Idempotency and audit (§20).** Webhooks and side effects tolerate retries; privileged changes are
  audited.
- **Never log secrets (§21).** Not in logs, traces, prompts, audit payloads, API responses or errors.
- **Tests are part of the feature (§23).**
- **Do not silently change architecture (§24).** Write an ADR (below).

`pnpm lint` (`scripts/check-source-guards.mjs`) enforces the mechanical parts: file size, import
boundaries (packages never import an app, apps never import each other, `@ocso/domain` imports no other
`@ocso` package, no relative imports into another package) and no dependency cycles between workspace
packages.

Code conventions (ADR-001, ADR-003): TypeScript 7, ESM with `.js` import suffixes, a strict config with
`noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. NestJS decorators and modules exist only in
`apps/*`; packages are plain TypeScript with explicit contracts. Import Nest injectables as values, never
with `import type`, or their decorator metadata is erased.

## Database migrations

The schema is Drizzle, in `packages/db/src/schema/*.ts`. Migrations are SQL files committed under
`packages/db/migrations/` and applied by OCSO's own runner (ADR-004).

1. Change the schema in `packages/db/src/schema/`.
2. Generate the migration:

   ```bash
   pnpm --filter @ocso/db db:generate
   ```

3. For SQL the schema DSL cannot express (triggers, check constraints, partial indexes written by hand),
   create an empty migration and write it yourself:

   ```bash
   pnpm --filter @ocso/db exec drizzle-kit generate --custom --name <short_name>
   ```

4. Commit the `.sql` file together with the updated `migrations/meta/` journal and snapshot.

Rules:

- **Never edit a migration that has been committed.** The runner stores a checksum of every applied file
  and refuses to start if one changed. Fix forward with a new migration.
- **Expand, then contract.** A release only adds schema that the previous release still works with.
  Drop or rename in a later release. There are no down-migrations; rollback is restoring a backup.
- The runner runs only as the explicit `migrate` step (the Compose one-shot service), never at api or
  worker start-up.

## Tests

| Tier | Where | Run |
|---|---|---|
| Unit | `packages/*/test/**/*.test.ts`, `apps/*/test/unit/**` | `pnpm test` |
| Integration (real PostgreSQL) | `**/*.int.test.ts` | `pnpm test:int` |
| Browser (Playwright) | `apps/web/e2e/*.spec.ts` | `pnpm --filter @ocso/web test:e2e` |
| Resilience | `tests/resilience/` | `pnpm test:chaos`, `pnpm test:load` |
| Source guard script | `scripts/test/` | `node --test scripts/test/` |

Run one file or one test:

```bash
pnpm exec vitest run --project unit packages/channels/test/twilio-send.test.ts
pnpm exec vitest run --project integration packages/application/test/alerts-lifecycle.int.test.ts -t "<test name>"
```

Integration tests create and drop a database per file on the server in `OCSO_TEST_DATABASE_URL` (default
`postgres://localhost:5432/postgres`). For example:

```bash
docker run -d --name ocso-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:18
OCSO_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres pnpm test:int
```

Browser tests run against a throwaway stack (fresh database, built api and worker, production web build).
Build the api and worker first, then run all specs or one:

```bash
pnpm turbo run build --filter=@ocso/api... --filter=@ocso/worker...
pnpm --filter @ocso/web exec playwright install chromium
export E2E_PG_URL=postgres://postgres:postgres@localhost:5432
pnpm --filter @ocso/web test:e2e
pnpm --filter @ocso/web exec playwright test e2e/webchat.spec.ts
pnpm --filter @ocso/web exec playwright test e2e/workspace.spec.ts -g "<test title>"
```

`E2E_VERBOSE=1` streams the server logs. `E2E_KEEP_DB=1` keeps the database after the run.

What to test (build rule §23): domain behaviour, permission boundaries, adapter contracts (copy the
shared contract suites for channels and model providers), failure and retry paths, concurrency and
idempotency, and handoff. Provider and channel tests run offline against recorded provider-shaped
responses through an injected `fetch`; never call a live API from a test.

## Architecture decision records

Decisions live in [PM/ARCHITECTURE-DECISIONS.md](PM/ARCHITECTURE-DECISIONS.md). Write a new ADR when you:

- change a contract, a boundary between packages or apps, or the data model in a way others must follow;
- add a dependency that shapes the architecture;
- deviate from a rule or from the spec in `docs/`.

Records are append-only. Use the next number, the status `PROPOSED` until the change is reviewed, and the
same sections as the existing records: Decision, Why, Alternatives, Consequences, and Spec impact. A
replaced decision is marked `SUPERSEDED by ADR-NNN`, not deleted. Update the affected docs in the same
change (build rule §24).

## Commits and pull requests

- Keep a pull request to one concern. A vertical slice (schema, service, API, UI, tests) is better than
  a layer at a time (build rule §22).
- Commit messages: one plain summary line saying what changed, in the style of the existing history
  (for example "Team membership management: team drawer, add/remove with consequences"), then a body
  explaining why if it is not obvious.
- In the pull request, say what changed, why, and how you tested it. Include screenshots for UI changes.
- The PR template has the checklist: typecheck, lint, tests, a generated migration if the schema changed,
  an ADR if the change is architectural, and updated docs.
- CI runs source guards, typecheck, unit and integration tests, the web build, Docker image builds,
  Compose config and Terraform validation. The Playwright job runs but does not block merges yet.
- Never commit secrets, `.env` files, database dumps or real customer data.

## Documentation

- Operator-facing changes: update `docs/operations/` (Compose, setup guide, scaling).
- Behaviour that refines the spec: update the "Implementation notes (as built)" section of the relevant
  `docs/NN-*.md` file.
- Plugins: update the matching page in `docs/plugins/`.

## Code of conduct

Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
