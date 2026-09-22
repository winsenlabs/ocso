# OCSO — Open Customer Service Orchestrator

OCSO is an open-source, self-hosted runtime for AI employees that talk to your customers: support,
sales, collections, onboarding. You run named virtual agents on WhatsApp and web chat, give them tools
from your own systems over MCP, and let your people take over any conversation and hand it back. One
deployment belongs to one organization (single-tenant, multi-user) and runs on any Docker host.
It is for teams that want the customer conversation, the model choice and the data to stay under their
own control.

Status: pre-1.0, under active development. See [Status and known gaps](#status-and-known-gaps).

## What you get

- **Virtual agents with versioned prompts.** Prompts are built from named components by a prompt
  compiler. Every change is a new immutable version with a reason; you preview the compiled prompt and
  its cache-prefix hash, replay a draft against past conversations, activate, and roll back.
- **Channels.** WhatsApp through Twilio or directly through the Meta Cloud API, and an embeddable web
  chat widget (one script tag) with optional signed customer identity. Text, images, audio, video,
  documents and locations are stored as typed message parts, not as flat text.
- **Human handoff and the CS workspace.** Conversations move through explicit control states (AI active,
  escalation requested, waiting for a human, human active, AI resuming, resolved). Escalation rules,
  queues with SLA policies, auto-assign or open pickup, transfers, internal notes, copilot reply drafts,
  and return to the AI. Every control change is audited.
- **Roles and team-scoped ownership.** Platform Tech Admin, CS Lead and CS Exec, with permissions checked
  in code. Virtual agents are owned by teams, and a CS Lead sees and manages only the agents their teams
  own, with those agents' conversations, analytics and alerts.
- **Sign-in and account security.** Better Auth: email and password with invites, TOTP with backup
  codes, passkeys, OIDC and SAML single sign-on, MFA required per role, session management and a
  break-glass recovery path.
- **Email.** Invites, password resets and alert emails through Resend or any SMTP relay.
- **Tools over MCP.** Connect any MCP server (Streamable HTTP) with OAuth 2.1 or a static header.
  Classify each tool's risk, approve it per agent, add argument rules, and require a human to confirm
  sensitive actions. Authorization happens in code, never in the prompt.
- **Six model providers.** AWS Bedrock, Google Vertex AI, Microsoft Foundry, OpenAI, Anthropic and
  Sarvam, each with its own prompt-caching strategy. Agents use logical model profiles with ordered
  fallbacks, checked against a deployment policy (provider allowlist, data residency, cross-provider and
  cross-region fallback).
- **Realtime.** The staff app, the web chat and Ask OCSO stream over server-sent events; changes fan out
  through PostgreSQL `LISTEN/NOTIFY`. There is no WebSocket endpoint.
- **Workers that survive failure.** Conversations are leased to workers in PostgreSQL. Scale workers up
  or down, or kill one mid-turn, and another resumes the conversation. The chaos test checks that every
  customer message still gets exactly one reply.
- **Observability and alerts.** Separate views for the Tech Admin (workers, queues, latency, tokens,
  prompt-cache hits, cost, provider and MCP health) and for CS Leads (containment, escalations, SLA,
  CSAT, reviews, prompt corrections). Alert rules with a lifecycle, delivered in-app, by email, to Slack,
  Microsoft Teams, PagerDuty or a signed webhook. OpenTelemetry export.
- **Ask OCSO.** An internal agent (⌘J / Ctrl+J) that answers questions about the deployment with the
  asking user's permissions and asks before it changes anything.
- **Operations.** Signed outbound webhooks for events, an append-only audit log, per-class data
  retention, and a first-run setup flow.

## Everything is a plugin

OCSO is a core plus contracts. The core owns the conversation runtime, handoff, roles and permissions,
audit, queues and leases, and observability. Everything that touches an outside system is an
implementation of a contract, looked up in a registry by kind. Core code never switches on a provider or
channel name (build rules [§2 and §4](docs/99-BUILD-RULES.md)).

| Extension point | Contract | Shipped implementations | What the core does for you |
|---|---|---|---|
| Channels | `ChannelAdapter` — `packages/channels/src/contract/types.ts` | WhatsApp via Twilio, WhatsApp via Meta Cloud API, web chat | Webhook routing, verify-then-persist ingress with dedupe, customer identity, media jobs, customer-safe rendering, delivery retries, admin form from JSON Schema, encrypted secrets |
| Model providers | `ProviderDefinition` — `packages/model-providers/src/providers/definition.ts` | Bedrock, Vertex AI, Foundry, OpenAI, Anthropic, Sarvam | Shared AI SDK call path, usage and error normalization, health checks, profiles and fallbacks, admin form from schemas, cost telemetry |
| Tool servers | MCP (runtime, no code); `ToolProvider` — `packages/tools/src/provider.ts` | Any MCP server over Streamable HTTP | OAuth 2.1, discovery, risk classification and approval, authorization, human confirmation, SSRF-guarded egress, audit |
| Alert destinations | `AlertDeliveryAdapter` — `packages/alerts/src/contract.ts` | In-app, email, Slack, Teams, webhook, PagerDuty | Per-event dispatch, retries, encrypted secrets, test button |
| Alert conditions | `EvaluatorDefinition` — `packages/application/src/alerts/evaluators/contract.ts` | Technical and business conditions | Scheduling, dedupe, open/acknowledged/resolved lifecycle, rule form from JSON Schema |
| Email | `EmailSender` — `packages/email/src/contract.ts` | Resend, SMTP, log | Templates, start-up validation, test button |
| Blob, secrets, queue, deployment | `BlobStore`, `SecretStore`, `QueueAdapter`, `DeploymentAdapter` | Volume or S3; local AES-256-GCM or AWS Secrets Manager; PostgreSQL or SQS; Compose or ECS | Chosen by one environment variable each; no product code branches on them |
| Scheduled tasks | `ScheduledTask` — `apps/worker/src/scheduler/scheduler.service.ts` | Lease recovery, auto-assign, alert evaluation, retention and more | Leader election across workers, intervals, error isolation |
| Ask OCSO tools | `InternalTool` — `packages/internal-agent/src/contract.ts` | 12 read and write tools | Permission filtering, re-authorization, confirmation for writes, audit |
| Sign-in and SSO | Better Auth plugins; identity providers at runtime | Password, TOTP, passkeys, OIDC, SAML | Endpoint allowlist, MFA policy, audit |

Be clear about what "plugin" means today: plugins are **compiled in and live in this repository**. A new
kind is a module behind the contract plus one registration line, and for channels, model providers and
alert destinations also an entry in a kinds constant. There is no runtime loader for third-party npm
packages yet. Two extension points need no code at all: MCP tool servers and SSO identity providers are
added in the web app.

**Next: a plugin SDK.** The next piece after this documentation is `@winsendotai/ocso-plugin-sdk`: a
stable, versioned package exporting the plugin contracts, plus a loader that registers plugin packages
named in configuration. It does not exist yet.

Start at [docs/plugins/](docs/plugins/README.md). It has one page per extension point, a worked example
([add a channel in seven steps](docs/plugins/add-a-channel.md)), and an honest list of places where the
plugin boundary still leaks.

## Architecture

```
  Customers                                                 Staff (browser)
  WhatsApp via Meta or Twilio, web chat widget              CS Exec, CS Lead, Platform Tech Admin
        │                                                          │
        ▼                                                          ▼
  ┌─────────────────────── web · Next.js · the only published port (3000) ───────────────────────┐
  │ staff UI and BFF (server actions, SSE relay)       /channels /public /oauth /.well-known /blobs │
  │ /api/auth/* → Better Auth on the api               are proxied to the api (public ingress)      │
  └───────────────────────────────────────────┬────────────────────────────────────────────────────┘
                                              │ internal network: /v1 with a Bearer session
                                              ▼
  ┌──────────── api · NestJS ────────────┐           ┌──────────── worker × N · NestJS ─────────────┐
  │ /v1 control plane (deny by default)  │           │ AI turns under conversation leases           │
  │ channel webhooks: verify → persist   │  queue    │ prompt compiler → model gateway → tool runner │
  │ Better Auth, realtime SSE, Ask OCSO  │ ────────► │ delivery, media, summaries, copilot, alerts   │
  │ admin for agents, channels, models   │           │ scheduler leader, worker scaling              │
  └──────────────────┬───────────────────┘           └──────────────────────┬───────────────────────┘
                     │                                                      │
                     ▼                                                      ▼
  ┌──────────────────────────────── PostgreSQL 18 · system of record ─────────────────────────────────┐
  │ conversations and parts, configuration, audit, encrypted secrets, jobs, leases, outbox + NOTIFY    │
  └────────────────────────────────────────────────────────────────────────────────────────────────────┘
     Blob store: a local volume or S3.
     Outbound, through plugins: model providers · MCP servers · WhatsApp APIs · email · alert destinations
```

- **PostgreSQL is the durable truth.** An inbound message is committed before anything else happens.
  Queue messages are only wake-ups. Worker memory is a cache.
- **API and worker scale independently.** They share packages and one Docker build, but run as separate
  processes. Any worker can pick up any conversation.
- **The browser only talks to the web app.** The staff API (`/v1`) is not reachable from outside; the
  web app calls it over the internal network (ADR-020).

More: [docs/02-SYSTEM-ARCHITECTURE.md](docs/02-SYSTEM-ARCHITECTURE.md) and the decision records in
[PM/ARCHITECTURE-DECISIONS.md](PM/ARCHITECTURE-DECISIONS.md).

Built with TypeScript 7, NestJS 12, Next.js 16, PostgreSQL 18 with Drizzle, the Vercel AI SDK (model
calls and the web chat's `useChat`), the official MCP TypeScript SDK and Better Auth.

## Repository map

| Path | What it is |
|---|---|
| `apps/api` | NestJS control plane: `/v1` staff API, public ingress (channel webhooks, web chat API, OAuth callback, JWKS, signed blob URLs), Better Auth, SSE, Ask OCSO, demo seed |
| `apps/worker` | NestJS worker: AI turns, outbound delivery, media fetch, summaries and insights, copilot, alert delivery, the scheduler, worker scaling |
| `apps/web` | Next.js staff UI and BFF; the customer web chat page and its embed loader (`public/ocso-webchat.js`) |
| `packages/agent-runtime` | Turn processing, conversation leases, model gateway (fallbacks, usage), tool runner, context building and turn cache, delivery |
| `packages/alerts` | Alert delivery adapters and their registry; rule and rendering helpers |
| `packages/application` | Application services: sign-in (Better Auth), users and teams, agents and prompts, conversations and handoffs, routing, channels, MCP, models, alert engine and evaluators, analytics, audit, retention, webhooks |
| `packages/auth` | Roles, permissions and the principal |
| `packages/blob` | `BlobStore` contract; local and S3 drivers; media checks |
| `packages/bootstrap` | Composition shared by api and worker: registries and driver selection |
| `packages/channels` | `ChannelAdapter` contract and registry; WhatsApp (Meta), WhatsApp (Twilio), web chat |
| `packages/config` | Typed, validated environment configuration |
| `packages/db` | Drizzle schema, committed SQL migrations, the migration runner |
| `packages/deployment` | `DeploymentAdapter`: Compose (advisory) and ECS scaling |
| `packages/domain` | Framework-free domain: control states and transitions, message parts, routing, SLA, errors |
| `packages/email` | `EmailSender` contract; Resend, SMTP and log senders; templates |
| `packages/events` | Event catalogue and envelope |
| `packages/internal-agent` | Ask OCSO: permission-filtered tools over application services |
| `packages/mcp` | MCP client: discovery, OAuth 2.1, egress guard, health, tool provider |
| `packages/model-providers` | Provider contract and registry, the six providers and a dev-only scripted one, the shared AI SDK core |
| `packages/observability` | Logging (pino), OpenTelemetry setup, metrics |
| `packages/prompt-compiler` | Versioned prompt components → system blocks, cache-prefix hashes, token estimates |
| `packages/queue` | `QueueAdapter` contract; PostgreSQL and SQS drivers |
| `packages/secrets` | `SecretStore` contract; local (AES-256-GCM) and AWS Secrets Manager drivers |
| `packages/tools` | `ToolProvider` contract, tool authorization, argument rules, sanitization |
| `examples/mcp-bank-demo` | An external MCP server for a fictional bank, used by the demo and the tests |
| `examples/webchat-host` | A host page showing the web chat embed and `identify()` |
| `infra/compose` | Compose helpers: key generation, entrypoint, Caddy TLS overlay, debug overlay, OTel Collector config |
| `infra/aws/terraform` | ECS Fargate infrastructure (validated, not yet applied; see known gaps) |
| `docs/`, `PM/`, `design/` | Specifications and runbooks; build plan and architecture decisions; UI mockups |
| `tests/resilience`, `scripts/` | Chaos and load scripts; source guards |

## Quickstart with Docker Compose

You need Docker Engine 26+ with Compose v2.30+. 4 vCPU and 8 GB RAM are enough for a pilot.

```bash
git clone https://github.com/winsenlabs/ocso.git && cd ocso
cp .env.example .env
docker compose up -d --build     # keygen → postgres → migrate → api + worker → web
docker compose ps                # api, worker, web healthy; keygen and migrate exited (0)
```

On first start the `keygen` one-shot writes every missing secret (database password, SecretStore master
key, blob signing key, Better Auth secret, first-run setup token) to the `secrets` volume. Nothing secret
goes into `compose.yaml`, `.env` or git. Back up that volume with the database: without the master key,
stored credentials cannot be decrypted.

Open <http://localhost:3000>. You are sent to `/setup`, which asks for the one-time setup token:

```bash
docker compose logs api | grep "setup token"
```

Then follow [docs/operations/setup-guide.md](docs/operations/setup-guide.md): model providers and
profiles, channels, MCP servers, teams, then your first virtual agent.

**Try the demo instead** (a fictional bank with users, teams, queues, three live agents, a web chat
channel and an example MCP server; only on a fresh database):

```bash
OCSO_DEMO_SEED=true docker compose --profile demo up -d --build
docker compose logs seed         # prints the logins
```

The demo enables a development-only scripted model, so it needs no provider keys. Never use it for a
real deployment.

**Put it on a server with HTTPS.** Point a DNS record at the host and set these in `.env`:

```dotenv
OCSO_DOMAIN=support.example.com
OCSO_PUBLIC_URL=https://support.example.com
OCSO_HTTP_BIND=127.0.0.1
OCSO_TRUSTED_PROXY_HOPS=1
```

```bash
docker compose -f compose.yaml -f infra/compose/tls.yaml up -d --build
```

The overlay adds Caddy on ports 80 and 443. It gets and renews a Let's Encrypt certificate for
`OCSO_DOMAIN` and proxies to the web app, whose own port is then bound to localhost only.

**Configure email before inviting anyone.** Without it, invites and password resets only reach the log.
Set `EMAIL_DRIVER=resend` (or `smtp`), `EMAIL_FROM` and the key file as described in
[compose.md §9](docs/operations/compose.md#9-email-resend-or-smtp).

Everyday operations, upgrades, backups, scaling workers (`--scale worker=N`), observability and
troubleshooting are in [docs/operations/compose.md](docs/operations/compose.md).

## Configuration: what goes where

There are two places to configure OCSO, split by who needs them and when.

| | Deployment bootstrap | Application configuration |
|---|---|---|
| **Where** | Environment (`.env`) and secret files on the `secrets` volume | The web app; stored in PostgreSQL |
| **Who** | The operator | Platform Tech Admin and CS Leads |
| **What** | Database, SecretStore master key, blob signing key, Better Auth secret, setup and recovery tokens, email driver and Resend/SMTP credentials, public URL, session lifetimes, trusted proxy hops, queue/blob/secrets/deployment drivers, OpenTelemetry | Model providers and their credentials, model profiles and prices, channels and their tokens, MCP servers and their OAuth tokens, virtual agents, prompts, tool grants, escalation rules, queues, SLA policies, teams and users, alert rules and destinations, outbound webhooks, SSO providers, MFA policy, retention, worker scaling settings |
| **Secrets** | Generated by `keygen` or written by the operator as files | Entered once, stored encrypted in the SecretStore, never shown again |

The line is deliberate. What the deployment needs before anyone can sign in (the database, the keys
that decrypt stored data, the Better Auth secret, email for invites and resets) is bootstrap, so nothing
done in the web app can lock you out of it. One exception to "every secret entered in the web app goes
to the SecretStore": OIDC client secrets for SSO are stored by Better Auth in its `auth_sso_providers`
table (ADR-025).

The full variable list is in [.env.example](.env.example) and `packages/config/src/env.ts`.

## Security model

- **Deny by default.** The api's global `AuthGuard` (`apps/api/src/common/auth.guard.ts`) refuses any
  route without an explicit `@Public`, `@Authenticated`, `@RequirePermission` or
  `@RequireAnyPermission`. `apps/api/test/unit/route-access.test.ts` fails the build if a route has
  none, and pins the complete list of public routes.
- **Permissions in code.** Roles map to permissions in `packages/auth`. Services add resource checks and
  team scope (ADR-026). Nothing a model says can grant a permission; the internal agent acts with the
  user's own permissions.
- **Small public surface.** Only the web app is published. `/v1` accepts only a signed Bearer session
  token, never cookies. Better Auth endpoints are an allowlist, pinned by
  `apps/api/test/unit/auth-surface.test.ts`. Channel webhooks are verified by signature before anything
  is stored.
- **Tools are authorized, not trusted.** Every tool call passes a deterministic check (approval, agent
  grant, scopes, argument schema and rules, conversation state). Sensitive actions wait for a human.
  Outbound calls to MCP servers and alert destinations go through an SSRF guard.
- **Secrets stay server-side.** Credentials are envelope-encrypted with the master key (or kept in AWS
  Secrets Manager), resolved only when used, and kept out of logs, traces, prompts, audit payloads and
  API responses.
- **Audit.** Privileged configuration changes, sign-in events and conversation control changes go to an
  append-only audit log; the database rejects updates and deletes on it. Every tool call is recorded
  with sanitized arguments.
- **Hardened containers.** Non-root, read-only root filesystem, no new privileges, all capabilities
  dropped; PostgreSQL on a network with no internet access.

Details: [docs/15-SECURITY-AND-GOVERNANCE.md](docs/15-SECURITY-AND-GOVERNANCE.md), ADR-020, ADR-021,
ADR-025 and ADR-026 in [PM/ARCHITECTURE-DECISIONS.md](PM/ARCHITECTURE-DECISIONS.md). To report a
vulnerability, see [SECURITY.md](SECURITY.md).

## Development

You need Node.js 26 (`.nvmrc`; `engines` allows 24+), pnpm 11.1.2 (pinned in `packageManager`), and
Docker or a local PostgreSQL 18 for integration tests.

```bash
pnpm install
pnpm build          # every package and app (turbo)
pnpm typecheck      # turbo; builds dependencies first
pnpm lint           # source guards: file size, import boundaries, package cycles
pnpm test           # unit tests (vitest)
pnpm test:int       # integration tests against PostgreSQL
```

Integration tests create and drop their own database per file on the server in
`OCSO_TEST_DATABASE_URL` (default `postgres://localhost:5432/postgres`), and run against source, so they
need no build.

Browser tests (Playwright) start a throwaway stack: a fresh database, the built api and worker, and a
production build of the web app. They need a PostgreSQL server at `E2E_PG_URL` and `psql` on your
`PATH`.

```bash
pnpm turbo run build --filter=@ocso/api... --filter=@ocso/worker...
pnpm --filter @ocso/web exec playwright install chromium
E2E_PG_URL=postgres://postgres:postgres@localhost:5432 pnpm --filter @ocso/web test:e2e
E2E_PG_URL=… pnpm --filter @ocso/web exec playwright test e2e/webchat.spec.ts   # one spec
```

Resilience scripts run real processes against a throwaway database
([docs/operations/resilience-testing.md](docs/operations/resilience-testing.md)):

```bash
pnpm test:chaos                                          # kill a worker mid-turn, then drain another
pnpm test:load -- --conversations 100 --messages 3 --workers 2
```

There is no single `pnpm dev` for the whole stack yet. For a running system, most work uses the Compose
stack plus the test suites. To run from source, build first, apply migrations with
`DATABASE_URL=… node packages/db/dist/bin/migrate.js`, then start `pnpm --filter @ocso/api dev` (it
reads the repo-root `.env`), `pnpm --filter @ocso/worker start` and `pnpm --filter @ocso/web dev`.
`apps/web/e2e/stack/start-api.mjs` shows the minimal environment the api and worker need.

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

## Documentation

| Topic | Where |
|---|---|
| Start here, reading order | [docs/00-INDEX.md](docs/00-INDEX.md) |
| Plugins and extension points | [docs/plugins/](docs/plugins/README.md) |
| Run it: Compose, setup, scaling, resilience | [docs/operations/](docs/operations/compose.md) |
| Product scope and personas | [docs/01-PRODUCT-PRD.md](docs/01-PRODUCT-PRD.md) |
| Architecture, domain model, runtime | [docs/02](docs/02-SYSTEM-ARCHITECTURE.md) to [docs/05](docs/05-PROMPTS-AND-CACHING.md) |
| Models, channels, MCP | [docs/06](docs/06-MODEL-PROVIDERS.md), [docs/07](docs/07-CHANNELS-AND-MULTIMODAL.md), [docs/08](docs/08-MCP-TOOLS-AND-AUTH.md) |
| Human operations and roles | [docs/09-HUMAN-OPERATIONS-AND-RBAC.md](docs/09-HUMAN-OPERATIONS-AND-RBAC.md) |
| Workers, observability, internal agent | [docs/10](docs/10-WORKERS-QUEUES-AND-SCALING.md), [docs/11](docs/11-OBSERVABILITY-ALERTS-AND-ANALYTICS.md), [docs/12](docs/12-INTERNAL-OCSO-AGENT.md) |
| Security and governance | [docs/15-SECURITY-AND-GOVERNANCE.md](docs/15-SECURITY-AND-GOVERNANCE.md) |
| Mandatory engineering rules | [docs/99-BUILD-RULES.md](docs/99-BUILD-RULES.md) |
| Architecture decision records | [PM/ARCHITECTURE-DECISIONS.md](PM/ARCHITECTURE-DECISIONS.md) |

The numbered docs are the original specification. Where the code refined them, an ADR records the
change and an "Implementation notes (as built)" section says what was built.

## Status and known gaps

OCSO is pre-1.0. APIs, the database schema and the plugin contracts can still change between commits on
`main`.

- **Deployment.** Docker Compose on a single host is the supported deployment. Terraform for ECS Fargate
  and the ECS scaling adapter exist, but AWS work is on hold: the Terraform has only been validated
  (`terraform validate`), never applied to a real account, and does not yet wire the Better Auth secret
  or email ([aws.md §10](docs/operations/aws.md#10-known-gaps-and-follow-ups)).
- **Plugins are compile-time.** Third-party plugins as npm packages wait for the plugin SDK. Some web
  app screens and a few core defaults still name specific kinds
  ([details](docs/plugins/README.md#where-the-boundary-leaks-today)).
- **Model providers** are tested against recorded provider-format responses, not live APIs; live
  verification needs your credentials. Sarvam's prompt caching is unverified.
- **WhatsApp** adapters are tested offline with fixtures; the items that need checking against a real
  number are listed in [packages/channels/README.md](packages/channels/README.md). Message templates,
  the only way to reach a customer 24 hours after their last message, are in progress.
- **Model discovery and catalog pricing** (listing a provider's models, suggesting prices) are in
  progress.
- **Channels not yet built:** `SMS`, `RCS`, `VOICE` and `CUSTOM_APP` are reserved kinds with no adapter.
  Web chat is the only embeddable channel.
- **MCP** uses Streamable HTTP only; there is no stdio transport.
- **Teams:** agents are team-owned, but queue configuration is still shared across teams (ADR-026).
- **Sign-in:** no email one-time codes as a second factor, and no "SSO only" enforcement per domain.
- **CI:** the Playwright job runs on every pull request but does not block merges yet.

## Contributing and security

- Contributions: [CONTRIBUTING.md](CONTRIBUTING.md). Proposals for new channels, providers or other
  plugins: open a "New plugin proposal" issue.
- Vulnerabilities: [SECURITY.md](SECURITY.md). Please do not open public issues for them.
- Conduct: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## License

Copyright 2026 Winsen Labs. Licensed under the Apache License 2.0. See [LICENSE](LICENSE) and
[NOTICE](NOTICE).
