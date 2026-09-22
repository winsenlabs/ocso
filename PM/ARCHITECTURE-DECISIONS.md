# OCSO Architecture Decisions

Each record states the decision, the context and why, alternatives considered, and consequences. Records are append-only; a superseded decision is marked **SUPERSEDED by ADR-NNN** rather than deleted. Where a decision refines the spec in `docs/`, the affected doc is listed under *Spec impact* and updated in the same change (build rule §24).

Status values: **PROPOSED** (awaiting verification), **ACCEPTED**, **SUPERSEDED**.

---

## ADR-001 — Monorepo shape: Nest modules in apps, framework-agnostic packages

**Status:** ACCEPTED (2026-09-22)

**Decision.** pnpm workspace with `apps/api` (NestJS HTTP control plane, webhooks, SSE), `apps/worker` (NestJS standalone context: turns, deliveries, schedulers), `apps/web` (Next.js UI + customer web chat widget), and `packages/*` containing plain TypeScript with explicit contracts (`domain`, `contracts`, `db`, `events`, `queue`, `auth`, `secrets`, `blob`, `config`, `observability`, `prompt-compiler`, `model-providers`, `agent-runtime`, `channels`, `mcp`, `alerts`, `deployment`). NestJS decorators/modules exist only inside `apps/*`; packages expose classes/functions and interfaces that Nest modules wire up.

**Why.** docs/02 §2 recommends this shape. Keeping packages framework-free makes the domain testable without Nest, prevents the DI container from becoming the architecture ("huge dependency containers" is an explicit anti-goal), and lets api and worker share logic while scaling independently (build rule §18).

**Alternatives.** Nest libraries inside a Nest monorepo (couples every package to Nest); single app with modes (merges execution responsibilities).

**Consequences.** Each app has thin Nest modules that bind package implementations to providers. Package dependency direction is enforced by lint (T1.1.2): `domain` imports nothing internal; adapters depend on `domain`/`contracts`, never on apps.

---

## ADR-002 — Single-tenant data model

**Status:** ACCEPTED (2026-09-22)

**Decision.** No `tenant_id` columns, tenant middleware or tenant switching. Organization identity (name, region label, data-residency zone, provider allowlist, retention policy) lives in a singleton `deployment_settings` record.

**Why.** docs/00, docs/03 §1, build rule §3.

**Consequences.** Separate organizations run separate deployments (separate databases). Nothing in queries, caches or events carries a tenant discriminator.

---

## ADR-003 — TypeScript 7 everywhere, ESM, plain `tsc` builds

**Status:** ACCEPTED (2026-09-22) — evidence in `research/04-backend-frontend-stack.md`.

**Decision.** `typescript@7.0.2` (native compiler) for every package and app, ESM (`"type": "module"`, `module: nodenext`, `.js` import suffixes), strict base config with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. NestJS apps add `experimentalDecorators` + `emitDecoratorMetadata` in their own tsconfig (NestJS 12 still uses legacy decorators + `reflect-metadata`; TS 7 emits the metadata correctly). Apps and packages build with plain `tsc -p tsconfig.build.json`; the Nest CLI is not used (it needs the TS JS API, absent until TS 7.1). Workspace packages export source through a custom `@ocso/source` condition for tests/typecheck and `dist` for production. Lint uses `oxlint` + `oxlint-tsgolint` (typescript-eslint requires the TS 6 API). Injectables are imported as values (never `import type`) so decorator metadata is not erased.

**Why.** Latest stable stack (build rule §1); ~10× faster type-checking in a large monorepo.

**Consequences.** No `nest generate`; modules are hand-written (they are small by rule anyway). If a Nest compile-time plugin is ever needed, only that app adds a TS 6 alias.

---

## ADR-004 — Drizzle ORM with committed SQL migrations and an OCSO migration runner

**Status:** ACCEPTED (2026-09-22) — evidence in `research/04`.

**Decision.** `drizzle-orm@0.45.3` (core query builder only; no relational-query v1 API) with the schema in `packages/db/src/schema/*.ts`; `drizzle-kit@0.31.11 generate` produces SQL files committed under `packages/db/migrations/` (hand-written SQL via `--custom` for triggers/partial indexes). Migrations are applied by OCSO's own runner (`packages/db/src/migrate.ts`): files sorted by name, `schema_migrations(name, checksum)`, one transaction per file, `pg_advisory_lock`, refuses to run when an applied file was edited. The runner is the `migrate` deploy step (Compose one-shot service, ECS one-off task) and is never invoked from api/worker boot.

**Why.** Drizzle 0.45's own migrator silently skips files older than the last applied one and has no lock or checksum. Drizzle gives typed queries, `.for('update', { skipLocked: true })` and a `sql` escape hatch with no runtime codegen.

**Consequences.** Revisit Drizzle 1.0 when it leaves RC; staying on the core builder keeps that migration cheap.

---

## ADR-005 — Conversation control state machine

**Status:** ACCEPTED (2026-09-22)

**Decision.** Store the six control states from docs/03 §3 (`AI_ACTIVE`, `ESCALATION_REQUESTED`, `WAITING_FOR_HUMAN`, `HUMAN_ACTIVE`, `AI_RESUMING`, `RESOLVED`) as `conversations.control_state`. The coarser `control_mode` from docs/03 §2 (`AI | WAITING_HUMAN | HUMAN | RESOLVED`) is a derived projection, not stored separately. All transitions go through one pure transition function in `packages/domain` with an explicit table of `(from, command) → to`, required actor type and guards. Business status is orthogonal.

Commands: `REQUEST_ESCALATION`, `ROUTE_TO_QUEUE`, `CLAIM`, `ACCEPT_ASSIGNMENT`, `TAKE_OVER`, `RELEASE_TO_QUEUE`, `RETURN_TO_AI`, `CANCEL_RETURN`, `RESUME_AI`, `CANCEL_ESCALATION`, `RESOLVE`, `REOPEN`.

Autonomous customer-facing AI output is permitted **only** in `AI_ACTIVE`. `AI_RESUMING` becomes `AI_ACTIVE` when the next customer message arrives (or immediately if the agent is configured to send a follow-up), matching the design ("Maya resumes on the next customer message").

**Why.** A single transition function makes the "AI must not reply while a human owns the conversation" rule checkable in one place (runtime guard + worker check at send time) and exhaustively testable.

**Consequences.** Transitions are persisted with optimistic concurrency (`conversations.version`) and audited; the worker re-reads the state immediately before any customer-visible write.

---

## ADR-006 — Model provider adapters on AI SDK v7; per-provider prompt caching

**Status:** ACCEPTED (2026-09-22) — evidence in `research/01-ai-sdk-and-providers.md` (request bodies and usage mapping verified by driving each provider package through a fake `fetch`; live calls need credentials).

**Decision.**
- One adapter module per provider behind OCSO's `ModelProviderAdapter { stream, generate, capabilities, health }`, registered in a provider registry (no central switch). All six share one AI-SDK core that wraps `streamText`; per provider only three things vary: the model-handle factory, the `providerOptions` builder (cache markers, cache keys, reasoning) and the usage/request-id extractor.
- Always pass model *instances* (a string model id silently routes to the Vercel AI Gateway). System content goes in `instructions: SystemModelMessage[]` (v7), one entry per compiler system block so breakpoints can attach per block. Always pass `toolOrder: []` and deterministic JSON Schema serialization; always resend tool definitions (Bedrock strips tool history otherwise); never use `activeTools` to vary tools.
- Tools are schema-only (`inputSchema` via `jsonSchema()`); the loop stops with `finishReason: 'tool-calls'` and OCSO executes tools (ADR-014).
- Usage is recorded **per step** from `usage.inputTokenDetails` (`cacheReadTokens`, `cacheWriteTokens`, `noCacheTokens`), `outputTokenDetails.reasoningTokens` and `performance.timeToFirstOutputMs`; `undefined` means "not reported", not zero.

| OCSO provider | Package / factory | Caching implementation |
|---|---|---|
| AWS Bedrock | `@ai-sdk/amazon-bedrock` `createAmazonBedrock({ region, credentialProvider })` (Converse) | `bedrock.cachePoint` after the last stable system block (covers tools+system) and at the conversation-context/history boundaries; max 4; `ttl` 5m/1h for Claude 4.5+ |
| Google Vertex AI | `@ai-sdk/google-vertex` `createGoogleVertex` (Gemini) + `/anthropic` `createGoogleVertexAnthropic` (Claude) | Gemini: implicit prefix caching (stable-prefix discipline; explicit `cachedContent` not used because the SDK also sends `systemInstruction`, which the API rejects); Claude: `anthropic.cacheControl` |
| Microsoft Foundry | `@ai-sdk/azure` `createAzure({ baseURL: …services.ai.azure.com/openai/v1 })` for OpenAI-family deployments; `@ai-sdk/anthropic` with baseURL `…/anthropic/v1` for Claude on Foundry | Azure OpenAI: `azure.promptCacheKey` (+ retention / 5.6+ breakpoints); Claude: `anthropic.cacheControl` (native endpoint only); other Foundry models: whatever the model server reports |
| OpenAI API | `@ai-sdk/openai` `createOpenAI` (Responses API) | automatic + `openai.promptCacheKey` sharded per agent-version prefix hash; `promptCacheRetention` (pre-5.6) or explicit breakpoints (5.6+) |
| Anthropic API | `@ai-sdk/anthropic` `createAnthropic` | explicit `anthropic.cacheControl` breakpoints (≤ 4) on stable system / conversation context / history tail |
| Sarvam API | `@ai-sdk/openai-compatible` `createOpenAICompatible({ name: 'sarvam', baseURL: 'https://api.sarvam.ai/v1', headers: { 'api-subscription-key' }, includeUsage: true })` | no documented control; adapter sends none, maps `cached_tokens` if Sarvam returns it, and declares `promptCaching: 'unverified'` |

**Why.** docs/06; build rules §10–12. `sarvam-ai-sdk` loses streamed usage and never maps cached tokens; no official Foundry package exists.

**Consequences.** Contract tests per provider assert the exact request body markers and usage mapping against recorded provider-format responses. Live verification of each provider requires its credentials (tracked per task in the build plan).

---

## ADR-007 — Channels: direct WhatsApp Cloud API adapter; web chat on AI SDK UI; Chat SDK reserved

**Status:** ACCEPTED (2026-09-22) — evidence in `research/02-chat-sdk-and-whatsapp.md`.

**Decision.**
- WhatsApp: implement the Cloud API directly inside OCSO's `WhatsAppChannelAdapter` (verification, signature over raw body, normalization of every inbound type including contacts and statuses, media download to BlobStore, sending, templates, error mapping), using the MIT-licensed `@chat-adapter/whatsapp` source as a reference for media safety and formatting.
- Web chat: our own endpoints + AI SDK UI (`useChat` with an OCSO transport) for the customer widget.
- Vercel Chat SDK (`chat`): not used for customer channels in v1; reserved for future staff-facing integrations (Slack/Teams handoff notifications and approvals), where its bot/thread model fits.

**Why.** The Chat SDK WhatsApp adapter only processes inbound messages inside a `Chat` pipeline that owns dedupe/locks/handlers; it drops delivery statuses and contacts messages, marks messages deduped before the handler runs (a failed persist would lose a Meta retry for 10 minutes), acknowledges before processing completes, drops concurrent messages by default and sends from a single configured phone number. OCSO requires persist-before-ack, delivery statuses, multi-number channels and its own queue/turn serialization (docs/07 §2–3, docs/10 §3). The web adapter requires the reply to be produced within the same HTTP request, which conflicts with worker-executed turns.

**Alternatives.** (a) Chat SDK as the WhatsApp transport — rejected for the reasons above. (c) A shim implementing Chat SDK's `ChatInstance` interface — rejected; ~25 members of foreign surface to maintain for little gain.

**Consequences.** OCSO owns Graph API version upgrades (version is configuration, default v26.0) and webhook security. Outbound sends are at-least-once on crash between send and record (Meta exposes no idempotency key); documented in the channel runbook.

**Spec impact.** docs/07 §4 ("use Vercel Chat SDK where it provides useful transport/UI primitives") — satisfied by AI SDK UI for the widget; Chat SDK usage deferred with rationale recorded here.

---

## ADR-008 — Queue abstraction; correctness from Postgres leases, not queue semantics

**Status:** ACCEPTED (2026-09-22; revised the same day after `research/05`, before implementation).

**Decision.** `QueueAdapter` contract: `publish(topic, payload, {groupKey, dedupeKey, delaySeconds})`, `consume(topic, handler, {concurrency})` with ack / retry-with-backoff / dead-letter / visibility extension, and `stats(topic)` (depth, oldest age). Queue messages are *wake-ups* (`{conversationId, eventId}` etc.); the work itself lives in Postgres. Two implementations:
- **Postgres** (Compose default): `jobs` table claimed with `FOR UPDATE SKIP LOCKED`; the claim query prefers jobs whose conversation lease is held by the claiming worker and skips jobs whose conversation is leased by another live, busy worker → real affinity.
- **SQS Standard + DLQ** (AWS): not FIFO. FIFO cannot delay individual messages, a failing message blocks its whole group, and DLQ redrive breaks FIFO order anyway. `ChangeMessageVisibility` is the heartbeat (12 h cap from first receive). Delays beyond SQS's 900 s limit go through a Postgres `scheduled_jobs` relay used identically in both modes.

**Serialization and exactly-one-responder.** Correctness never depends on queue ordering or single delivery:
1. A conversation lease row (`conversation_id`, `worker_id`, `lease_version`, `acquired_at`, `expires_at`, `heartbeat_at`, `busy`) is the only permission to run a turn.
2. A turn processes every customer interaction with `seq > last_processed_seq` and then *drains*: it marks the lease idle only with a conditional update that fails if new unprocessed interactions exist, in which case it loops.
3. A worker receiving a wake-up for a conversation leased by another live worker: if that lease is `busy`, it returns the message with a short visibility delay; if idle, it transfers the lease (version bump) and runs the turn; if expired, it takes it. Because ingress commits the interaction before publishing, one of the two workers always sees it.
4. **Fencing:** every customer-visible write (response interaction, outbound send, state transition) checks the caller's `lease_version` in the same transaction; a worker whose lease moved cannot write.
5. Turn jobs are idempotent; duplicate wake-ups no-op.

**Why.** docs/10 §2–4 (leases, preferred routing to the owning worker, no business code on SQS APIs) and §3 (no duplicate replies). The queue carries work signals, not conversation state (Postgres does).

**Consequences.** Postgres mode gives exact affinity; SQS mode gives best-effort affinity (idle-lease transfer means a cold turn cache on the new worker, which is correct because caches are derived). Both modes share the lease, drain and fencing code paths and the same queue contract test suite.

---

## ADR-009 — Events: transactional outbox + Postgres LISTEN/NOTIFY for realtime

**Status:** ACCEPTED (2026-09-22)

**Decision.** Domain events (docs/02 §8, docs/14 §4 envelope) are written to an `outbox_events` table in the same transaction as the state change. A relay publishes them to (1) realtime subscribers via `pg_notify` on a small set of channels, consumed by every API instance and fanned out over SSE to permitted browser sessions; (2) outbound webhooks and alert evaluation. Ephemeral stream deltas (`agent.response_delta`) are NOTIFY-only and never persisted.

**Why.** Works identically on Compose and RDS without another broker; the outbox guarantees events are never emitted for rolled-back changes.

**Consequences.** NOTIFY payloads stay small (ids + type); subscribers load details with authorization applied. SSE fan-out re-checks the subscriber's permission per event.

---

## ADR-010 — Built-in authentication with server-side sessions

**Status:** ACCEPTED (2026-09-22)

**Decision.** OCSO ships its own email/password authentication (memory-hard password hashing), server-side sessions (random token, SHA-256 hash stored, HttpOnly + Secure + SameSite=Lax cookie, idle + absolute expiry, revocation), login throttling and audit. First-run setup is a web page guarded by a one-time setup token (logged by the API on first start or supplied via env) that creates the first Platform Tech Admin. OIDC SSO is a later additive epic.

**Why.** No external identity dependency for a self-hosted single-tenant product; no CLI for bootstrapping (product rule).

---

## ADR-011 — Blob storage drivers

**Status:** ACCEPTED (2026-09-22) — evidence in `research/05`.

**Decision.** `BlobStore` contract with two drivers: `local` (filesystem volume; default for Compose) and `s3` (AWS S3 with SSE-KMS bucket default; presigned GET/PUT with `requestChecksumCalculation: "WHEN_REQUIRED"` on the presigning client, otherwise browser PUTs fail the empty-body checksum). The `s3` driver accepts a custom endpoint + path-style addressing so an S3-compatible store (SeaweedFS, Apache-2.0) can be used via an optional Compose profile. MinIO is not used: its Docker Hub image is gone and the repo is archived (2025–26).

**Why.** docs/07 §6 and docs/13 §2 ("optional local S3-compatible storage"); the default Compose install stays one volume with no extra service.

---

## ADR-012 — Secret store

**Status:** ACCEPTED (2026-09-22), AWS details refined by `research/05`.

**Decision.** `SecretStore` contract: `put(name, value) → ref`, `rotate(ref, value)`, `resolve(ref)` (server-side only), `describe(ref)` (metadata only), `delete(ref)`. Drivers: `local` (AES-256-GCM envelope encryption, master key from a mounted file/env, ciphertext in Postgres `secrets` table) for Compose; `aws` (Secrets Manager) for AWS. All other tables store only `secret_ref`. No API ever returns secret values after creation.

**Why.** docs/06 §6, docs/08 §5, docs/15 §3.

**Consequences.** Local driver security depends on protecting the master key file; documented in the Compose hardening guide.

---

## ADR-013 — Internal notes stored separately from interactions

**Status:** ACCEPTED (2026-09-22)

**Decision.** Internal notes live in `internal_notes`, not in `interactions`. The timeline API merges them for staff views; channel rendering reads only `interactions` with customer visibility.

**Why.** docs/09 §5 requires notes to be represented separately and never rendered to customers; a separate table makes leakage structurally impossible rather than a filter someone can forget.

---

## ADR-014 — OCSO executes tools; the AI SDK never auto-executes

**Status:** ACCEPTED (2026-09-22)

**Decision.** Tool definitions passed to the AI SDK carry schemas but no `execute` functions. The runtime receives tool-call parts, runs them through `ToolAuthorizer` (docs/08 §6 eight checks), persists the tool call before any side effect, executes via the MCP/tool provider, persists the result, and continues the loop with typed, sanitized results.

**Why.** Authorization, confirmation, audit and idempotency must be enforced in OCSO code between the model's request and the side effect (build rules §12, §14).

---

## ADR-015 — Dev-only scripted model provider

**Status:** ACCEPTED (2026-09-22)

**Decision.** A deterministic `dev-scripted` provider (keyword-driven replies, tool calls and handoff requests, configurable latency and usage figures) is registered only when `OCSO_ENABLE_DEV_PROVIDERS=true`. It powers the Compose demo without credentials and all end-to-end tests. It is labelled "development only" in the UI and rejected by config validation when `NODE_ENV=production` unless explicitly overridden.

**Why.** The definition of complete requires a runnable end-to-end system and automated tests without vendor credentials; the six real providers are still implemented and contract-tested with recorded fixtures.

---

## ADR-016 — In-product telemetry from Postgres read models; OpenTelemetry for export

**Status:** ACCEPTED (2026-09-22)

**Decision.** Role dashboards are computed by OCSO from Postgres read models (usage_events, turns, tool_calls, health samples, worker heartbeats, queue stats, alerts). OpenTelemetry traces/metrics/logs are exported via OTLP to any backend (Jaeger/collector in Compose; ADOT/CloudWatch on AWS). Turns, usage events and tool calls store `trace_id` so the UI can link to the external trace view.

**Why.** The product must show role-specific observability without requiring an external metrics stack, while still integrating with enterprise telemetry (docs/11 §5).

---

## ADR-017 — Internal OCSO agent over application services

**Status:** ACCEPTED (2026-09-22)

**Decision.** The internal agent runs in the API process on behalf of the authenticated user. Its tools are thin adapters over the same application services the controllers use, each declaring a permission and a risk class (`READ`, `LOW_WRITE`, `HIGH_WRITE`). The catalogue is filtered by the user's permissions before the model sees it and every execution is re-authorized. `HIGH_WRITE` actions create a pending action that executes only after an explicit UI confirmation. Audit records use `via = INTERNAL_AGENT` with the human as actor.

**Why.** docs/12 §3–6: no backdoor, inherited RBAC, confirmation and audit.

---

## ADR-018 — Scheduler leadership via Postgres advisory lock

**Status:** ACCEPTED (2026-09-22)

**Decision.** Periodic jobs (alert evaluation, SLA checks, lease recovery sweep, health sampling, metric publication, retention) run in worker processes; one worker holds a session-level `pg_try_advisory_lock` per scheduler group and others stand by.

**Why.** No extra coordination service; safe with any number of workers on Compose or ECS.

---

## ADR-019 — Default turn concurrency policy: queue behind

**Status:** ACCEPTED (2026-09-22)

**Decision.** Customer messages arriving mid-turn are, by default, queued and handled together in the next turn (`QUEUE_BEHIND`). `CANCEL_AND_RESTART` is available per agent and only cancels if no customer-visible output has been sent and no side-effecting tool has executed in the current turn.

**Why.** docs/04 §7 requires deterministic, configurable behavior; queue-behind never discards work and is safe with side-effecting tools.

---

## ADR-020 — Next.js as backend-for-frontend; public ingress routed to the API

**Status:** ACCEPTED (2026-09-22) — evidence in `research/04` §3.

**Decision.** Staff browsers talk only to the Next.js app. The session token lives in an `httpOnly; Secure; SameSite=Lax` cookie set by a Next route handler after login; Server Components and server actions call the NestJS API with `Authorization: Bearer <session token>` over the internal network; realtime SSE is proxied through a Next route handler. `proxy.ts` does an optimistic cookie-presence redirect only — the API authorizes every call. Public ingress (channel webhooks `/channels/*`, the customer web-chat API `/public/*`, OAuth callbacks `/oauth/*`, JWKS `/.well-known/*`, signed blob downloads `/blobs/*`) is served by the API: on AWS through ALB path rules, on Compose through Next rewrites to the API service.

**Why.** No CORS, no API token in the browser, one public origin, and the API remains the only authorization point.

---

## ADR-021 — MCP client: official TypeScript SDK v2 with version negotiation; OCSO-owned OAuth orchestration

**Status:** ACCEPTED (2026-09-22) — evidence in `research/03-mcp-and-oauth.md`.

**Decision.**
- Use the split v2 SDK packages (`@modelcontextprotocol/client`, `@modelcontextprotocol/server` + `@modelcontextprotocol/node`/`express` for the demo server), not the legacy `@modelcontextprotocol/sdk@1.x`.
- Clients are created with `versionNegotiation: { mode: 'auto' }` so OCSO talks to both MCP 2026-07-28 servers (stateless: `server/discover`, no `initialize`/sessions/`ping`) and 2025-era servers.
- Health checks use `discover()` on 2026 servers and `ping()` only on 2025 servers.
- OAuth 2.1 is orchestrated server-side by OCSO using the SDK's exported helpers (server-info discovery → `startAuthorization` → callback → `exchangeAuthorization` → `refreshAuthorization`; `registerClient` fallback; Client ID Metadata Documents preferred per 2026 spec; admin-entered pre-registered client IDs supported). OCSO adds what the SDK leaves to the caller: mandatory PKCE `S256` advertisement check, `state` validation, RFC 9207 `iss` validation on callback, credentials keyed by authorization-server issuer, and an SSRF-guarded `fetch` for every metadata/token/MCP request.
- At runtime the transport receives only a minimal token provider (`{ token, onUnauthorized }`) backed by SecretStore; credentials never reach model context.
- The AI SDK's `@ai-sdk/mcp` client is not used: its `tools()` executes calls directly, bypassing OCSO's authorization/confirmation gate (ADR-014), and its OAuth support lags the 2026 spec. The model receives schema-only tool definitions built from admin-approved tool records.

**Why.** docs/08 §2 and §6, docs/15 §5; the MCP ecosystem is mid-migration between protocol generations, so auto-negotiation is required for real-world servers.

**Consequences.** OCSO owns the OAuth state machine (DB-backed PKCE/state records with expiry). Compose demo MCP server needs an explicit egress host allowlist because it lives on a private network (SSRF guard blocks private ranges by default).

**Implementation rules (as built).**
- Connection names are slugs (`[a-z0-9-]`, 2–40 chars) because they prefix model-facing tool names (`<connection>__<tool>`), which are unique deployment-wide; personal copies of a USER template get `<name>_u<8 hex>`.
- Plain `http://` is accepted only for `INTERNAL` connections whose host is in `egressAllowedInternalHosts`; everything else must be `https://`.
- Tool drift: a change to schema, title, description, output schema or annotations un-approves an approved tool (`changedSinceApproval`) — descriptions are model-visible, so they are a prompt-injection surface. Vanished tools get `removedAt`.
- OAuth `state` is stored only as a SHA-256 hash and the pending row is deleted before the exchange (single use). Refresh-token rotation is compare-and-swap on the secret version. The callback answers with a 302 carrying only the connection id and an ok/error code; the API request logger records paths without query strings.
- Personal copies auto-approve only tools whose definition exactly matches the admin-approved template tool.
- Known gap: a worker losing a refresh race may fail one call before re-reading rotated tokens (fix belongs in `@ocso/mcp` credential session).

**Spec impact.** docs/08 §2 "OAuth 2.1 flows where supported" — refined with the concrete client-registration order (CIMD → pre-registered → DCR fallback).

---

## ADR-022 — Infrastructure as code: Terraform

**Status:** ACCEPTED (2026-09-22) — evidence in `research/05`.

**Decision.** AWS infrastructure is Terraform (1.16.x, AWS provider 6.x) under `infra/aws/terraform` with modules: network, alb, ecs-cluster, service (reused for web/api/worker), rds, sqs, s3, secrets, observability, iam, ecr, migrate-task. Autoscaling min/max and policy thresholds are owned at runtime by OCSO's ECS deployment adapter, so Terraform declares them with `ignore_changes`. `terraform validate` runs in CI via the `hashicorp/terraform` container.

**Why.** Customer AWS accounts commonly standardize on Terraform; CDK needs an account bootstrap, and CloudFormation's update timeout interacts badly with long scale-in protection.

---

## ADR-023 — Worker autoscaling signals

**Status:** ACCEPTED (2026-09-22) — evidence in `research/05`; metric-math expression to be validated with GetMetricData before release.

**Decision.** The leader publishes CloudWatch metrics every 60 s (custom metrics are 1-minute resolution): `SlotDemand` (active + queued conversations), `Workers`, `OldestQueueAgeSeconds`, `TurnsInFlight`, `TurnLatencyP95`. ECS worker service scaling = target tracking on metric-math "slot demand per worker" with target = conversations-per-worker × target utilization, plus step scaling on queue age for bursts and scale-from-floor. Workers enable ECS task scale-in protection only while a turn is running (Fargate gives ≤ 120 s on stop). Tech Admin settings map to `RegisterScalableTarget` / `PutScalingPolicy` / `PutMetricAlarm` via the ECS deployment adapter; Compose deployment adapter reports settings as advisory (replica count is operator-controlled).

**Why.** docs/10 §6 — scale on conversation demand and queue age, not CPU.

**Implementation (as built).** Operator note: `docs/operations/worker-scaling.md`.

- **Package.** `@ocso/deployment` is framework-free. It defines the `DeploymentAdapter` contract: `describe`, `applyScaling`, `publishMetrics` and `taskProtection`. It has two drivers:
  - `ComposeDeploymentAdapter` is always ADVISORY. It returns the exact `docker compose up -d --scale worker=N` for the warm floor and lists the settings Compose cannot enforce.
  - `EcsDeploymentAdapter` uses AWS SDK v3. Its clients are injectable, so the tests use fakes rather than a mocking library.
  - Selection is `createDeploymentAdapter(env)` in `@ocso/bootstrap`, worker only.
- **Who applies.** Only the worker scheduler leader applies scaling. The worker is the one process with the scaling IAM.
  - It reconciles when it becomes leader, every 5 min, and on `config.changed{area:'workers'}` (leader only).
  - On ECS it publishes the metrics every 60 s.
  - `ScalingService` (`@ocso/application`) serializes and coalesces reconciles. It records every attempt in the singleton `worker_scaling_state`: status APPLIED/ADVISORY/FAILED, message, detail, the settings version applied, and the last `describe()` snapshot.
  - The API serves this record from the DB (`GET /v1/settings/workers` → `scaling`, `GET /v1/settings/workers/deployment`) and holds no AWS scaling permissions. `PENDING` = settings newer than the last attempt.
- **Terraform contract.** Terraform (ADR-022) creates the scalable target, `<ECS_CLUSTER>-worker-slot-demand` (target tracking), `<ECS_CLUSTER>-worker-queue-age` (step) and the alarm `<ECS_CLUSTER>-worker-queue-age-high`. It ignores the attributes OCSO owns at runtime.
  - The adapter addresses only those names. It never lists, deletes or creates anything else, and it fails (`scalable_target_missing`) rather than registering a target Terraform did not create.
  - Reconcile reads first and writes only what differs, comparing semantic fingerprints. Re-putting a target-tracking policy recreates its alarms, so an unconditional re-put every 5 min would keep resetting their evaluation.
  - The existing alarm keeps Terraform's metric (SQS `ApproximateAgeOfOldestMessage`). Only its threshold changes, plus the step policy in its actions if missing, so Terraform never fights it. A missing alarm is created on OCSO's `OldestQueueAgeSeconds`.
- **Signals.** Namespace `OCSO_METRICS_NAMESPACE` (default `OCSO/<ECS_CLUSTER>`), single dimension `Service=worker`, zeros published.
  - `SlotDemand` = busy leases + ready turn wake-ups (queue stats).
  - `Workers` = HEALTHY with heartbeat ≤ 3 × interval.
  - `OldestQueueAgeSeconds` comes from the queue driver. Under SQS, whose stats cannot report age, it is the oldest unprocessed customer message in an AI-controlled conversation with no running turn (the sweeper's predicate).
  - The metric math uses `Average` for both inputs, not `Sum`, so two leaders overlapping for a moment cannot double demand. Target = conversations per worker × utilization. Scale-out cooldown 60 s; scale-in cooldown from settings.
  - Step policy: +1 task at the threshold, +3 at threshold + 60 s. `scaleOutQueueDepth` needs no separate ECS rule because queued turns are already in `SlotDemand`.
- **Deviations from the decision text.**
  - (1) Autoscaling *off* pins min = max = warm floor and **leaves the policies and alarm in place** instead of deleting them. Terraform owns their existence and would recreate them, and with min = max they cannot move capacity.
  - (2) The fleet floor is ≥ 1 on every driver. The leader publishing the signals is a worker, so from zero the fleet could never scale out again. A setting of 0 is raised, with a warning.
  - (3) Suspended dynamic scaling and disabled alarm actions set outside OCSO are reported as warnings, not reverted.
- **Task protection.** `$ECS_AGENT_URI/task-protection/v1/state`, reference-counted around the `conversation.turn` handler.
  - Updates are serialized and computed from the holder count at send time, so bursts collapse into one call.
  - Expiry = 2 × turn timeout + 2 min, refreshed while turns keep running.
  - Failures are logged (rate-limited) and never affect a turn.
- **Still open.** The metric-math expression is unverified against real CloudWatch data (validate with GetMetricData). The protection toggle's API throttling behaviour under heavy churn is unmeasured.

---

## ADR-024 — OCSO turn cache: per-scope generation counters + per-worker hot cache

**Status:** ACCEPTED (2026-09-22) — recorded after implementation.

**Decision.** Derived context (agent prefix: prompt components + tool catalog; customer context; rolling summary; recent history) is cached in each worker's in-memory LRU (`HotContextCache`), keyed by conversation. Validity is decided by monotonic generation counters in `cache_generations`, one row per scope (`agent:<id>`, `customer:<id>`, `channel:<id>`, `profile:<id>`, `policy`, `global`). Any change that affects a scope bumps its counter in the same transaction as the change (prompt activation, tool grants, MCP approval/drift, customer edits, channel/profile changes); a turn reads the counters for its scopes (one query) and treats any mismatch as COLD. Turns record HOT/COLD in `turns.cache_layer`; context hashes are stored per turn.

**Why.** docs/05 §4–5 require OCSO-side turn caching with correct invalidation. Counters in Postgres keep every worker consistent without a shared cache service (build rule: Postgres is the durable truth), cost one indexed read per turn, and survive worker restarts (a new worker is simply COLD).

**Alternatives.** Redis/ElastiCache shared cache (another stateful dependency for Compose and AWS); TTL-only expiry (serves stale prompts after activation); pub/sub invalidation only (lost messages leave stale caches — kept as a latency optimisation via `cache.invalidated` events, not for correctness).

**Consequences.** Anything that changes prompt-relevant state must bump the right scope; tests cover prompt activation (runtime.int.test.ts HOT/COLD). Hot cache memory is bounded per worker (LRU size).

