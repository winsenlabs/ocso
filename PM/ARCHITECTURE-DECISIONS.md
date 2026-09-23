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

**Decision.** `typescript@7.0.2` (native compiler) for every package and app, ESM (`"type": "module"`, `module: nodenext`, `.js` import suffixes), strict base config with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. NestJS apps add `experimentalDecorators` + `emitDecoratorMetadata` in their own tsconfig (NestJS 12 still uses legacy decorators + `reflect-metadata`; TS 7 emits the metadata correctly). Apps and packages build with plain `tsc -p tsconfig.build.json`; the Nest CLI is not used (it needs the TS JS API, absent until TS 7.1). Workspace packages export source through a custom `@ocso/source` condition for tests/typecheck and `dist` for production. `pnpm lint` runs the repository's source guards (`scripts/check-source-guards.mjs`: file size, import boundaries, workspace dependency cycles, and the plugin boundary — core code names no plugin kind); no ESLint, oxlint or Prettier is configured (typescript-eslint requires the TS 6 API), so `tsc` strictness plus the guards are the static checks. Injectables are imported as values (never `import type`) so decorator metadata is not erased.

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

**Status:** ACCEPTED (2026-09-22); authentication **SUPERSEDED by ADR-025** (Better Auth). First-run setup with a one-time token remains.

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


---

## ADR-025 — Authentication on Better Auth; OCSO keeps authorization

**Status:** ACCEPTED (2026-09-22) — evidence in `research/07-better-auth.md`. Supersedes the authentication parts of ADR-010 (hand-built sessions, login throttling); ADR-010's first-run setup with a one-time token and ADR-020's BFF principle stay.

**Decision.** Authentication is **Better Auth 1.7.5** (MIT, self-hosted, pinned in the pnpm catalog with `@better-auth/passkey`, `@better-auth/sso`, `@better-auth/core`). Authorization is unchanged: roles → permissions, the deny-by-default `AuthGuard`, resource checks in services, conversation-level access.

- **Where it runs.** `createAuthServer()` (`@ocso/application/auth-server`, a separate entry point so the worker never loads it) builds Better Auth from the Drizzle db, the deployment `EMAIL_SENDER` (via `AuthMailer`), the auth policy and env. The API mounts `auth.handler` at `/api/auth/*` on the Express instance **before** any body parser (`common/auth-handler.ts`); it is not a Nest controller. Browsers reach it on the public origin: `apps/web/proxy.ts` rewrites `/api/auth/*` to the API and sets `x-ocso-client-ip` from the trusted proxy hop (a browser-supplied value is dropped). Cookies, SSO redirects/callbacks and WebAuthn therefore all live on `OCSO_PUBLIC_URL`.
- **HTTP surface is an allowlist.** OCSO's `ocso-policy` plugin answers 404 over HTTP for every Better Auth endpoint not in `HTTP_AUTH_ENDPOINTS` (sign-in/out, get-session, request/reset/change password, list/revoke sessions, TOTP + backup codes, passkeys, SSO sign-in/callback/ACS/SP metadata, `/error`). Sign-up, user self-updates, account linking and SSO *provider management* are in-process only. `apps/api/test/unit/auth-surface.test.ts` pins the list; `route-access.test.ts` still pins the Nest public routes (`POST /v1/setup/recover` added).
- **Data.** Better Auth's user model **is** `users` (`modelName: 'users'`; `role`/`status` declared as `additionalFields` with `input: false`; availability, languages, skills, maxConcurrent stay OCSO-only columns). New tables: `auth_sessions`, `auth_accounts`, `auth_verifications` (identifiers stored hashed), `auth_two_factors`, `auth_passkeys`, `auth_sso_providers`, `auth_rate_limits`, `auth_policy` (singleton). IDs are UUIDv7 via `advanced.database.generateId`. Passwords keep OCSO's scrypt format through `emailAndPassword.password.hash/verify`; migration 0014 moves `users.password_hash` into `auth_accounts` (`provider_id = 'credential'`), lower-cases emails (Better Auth compares lower-case), marks existing users verified; 0015 drops `sessions` and `password_hash`. `login_attempts` stays (per-account throttle + the auth-failure alert).
- **Sessions.** Better Auth cookie `ocso.session_token` (`__Secure-` prefixed when Secure), httpOnly, SameSite=Lax, no cross-subdomain cookies; Secure = `SESSION_COOKIE_SECURE`, default true when `OCSO_PUBLIC_URL` is https. Absolute lifetime = `session.expiresIn` = `SESSION_ABSOLUTE_HOURS` with refresh disabled (cookie Max-Age and row expiry agree; nothing extends a session). The idle window (`SESSION_IDLE_MINUTES`) is OCSO's: `auth_sessions.last_active_at`, bumped at most once a minute by the policy plugin, which deletes an idle session on its next use. The BFF forwards the session to the API as **`Authorization: Bearer <signed cookie value>`** (bearer plugin, `requireSignature: true`); `/v1` never accepts cookies. The guard calls `auth.api.getSession` (idle gate included), then builds the `Principal` with `loadPrincipal` exactly as before. Server actions call Better Auth's HTTP endpoints server-to-server (rate limits apply) and relay its `Set-Cookie` to the browser, so Better Auth stays the only cookie issuer.
- **Users.** Sign-up is disabled. First-run setup and OCSO's `UserService` write `users` + the credential account **directly in the same transaction as the audit record** (see deviations). Adding a user is an **invite**: no password; a single-use set-password token (Better Auth `reset-password:` verification, 72 h) is emailed and consumed by Better Auth's `/reset-password` on `/invite`; "Resend invite" replaces it; admins can also send a 24 h reset link. With the `log` email driver the API returns the link to the inviting admin (shown once, audited, never returned when a real driver is configured). Admin-set initial passwords remain only for API clients when email cannot be delivered (tests, seed). Role change and deactivation delete the user's `auth_sessions` rows.
- **Account security.** Forgot/reset password by email (1 h; all sessions end); change password (current password; other sessions end, audited, notification email); TOTP with 10 encrypted backup codes (`twoFactor`, `allowPasswordless` so SSO/passkey-only users can enrol); passkeys (`rpID` = host of `OCSO_PUBLIC_URL`, user verification required); session list with per-session and "all other" sign-out. **"Require MFA for roles"** (`auth_policy.require_mfa_roles`, Tech Admin): a session counts as multi-factor when `auth_method` ∈ {mfa, passkey, sso} (recorded at session creation from the endpoint). Otherwise `/v1` answers 403 `mfa_enrollment_required` except `@Authenticated({ allowPendingMfa: true })` routes, Better Auth only allows get-session/sign-out/2FA enrolment, and the web sends the user to `/mfa-setup`.
- **SSO.** `@better-auth/sso` (OIDC + SAML 2.0). Providers are managed only by the Tech Admin through `/v1/settings/sso-providers` (audited; client secrets write-only). OCSO does the OIDC discovery (only the issuer's own origin, public or listed in `OCSO_AUTH_TRUSTED_ORIGINS`) and registers with explicit endpoints; the acting admin becomes Better Auth's provider owner for deletes. Provisioning is `resolveUser`: the email must be on one of the provider's domains; an existing active user is linked (accepting an outstanding invite); unknown users are refused unless the provider's `autoProvision` is on (then created as CS Exec). Single tenant: no domain verification step (the Tech Admin binds domains).
- **Rate limiting.** Better Auth's limiter with `storage: 'database'` (all API instances share it), keyed by `x-ocso-client-ip`: sign-in 30/min, SSO sign-in 30/min, reset request 5/5 min, reset 10/5 min, change password 10/5 min, two-factor 15/min, passkeys 30/min, everything else 300/min. OCSO adds per-account (8 failures / 15 min) and per-address (40) throttling from `login_attempts` (the trust model of `OCSO_TRUSTED_PROXY_HOPS` is unchanged). Two-factor verification also locks after 10 consecutive failures (Better Auth).
- **Audit.** Sign-in success/failure (never the typed input for unknown accounts), sign-out, password reset requested/done, password change, invite sent/resent/accepted, admin reset link, MFA enrolment started/completed/disabled/failed, backup codes regenerated, passkey added/removed/renamed, session revocations, SSO provider create/update/delete, SSO refusals, policy changes, recovery. Better Auth's hooks run outside OCSO transactions, so an audit write failure is logged rather than failing a completed sign-in.
- **Streams.** OCSO streams over **SSE** (staff realtime `/v1/realtime/stream` through `app/api/realtime`, Ask OCSO chat through `app/api/internal-agent/*`, visitor web chat `/public/webchat/*/stream`); there is no WebSocket endpoint. SSE is plain HTTP, so every stream is authenticated by the same guard at connect time; long-lived staff streams re-check their session every `SESSION_STREAM_RECHECK_SECONDS` (60) and close when it was revoked, expired, idle, the user disabled, or the MFA policy no longer admits it; the client's reconnect then gets 401. The customer web chat keeps its visitor-token model.
- **Break-glass.** At least one active Platform Tech Admin must keep password sign-in: `UserService` refuses (409 `last_password_admin`) a role change or deactivation that would remove the last one. Recovery without a CLI: while the operator sets `OCSO_RECOVERY_TOKEN` (≥ 32 chars), `/recover` resets one active Tech Admin's password, removes their authenticator and ends their sessions; each token value works once (its hash is stored), audited as `auth.recovery`.

**Why.** A maintained, audited library for the parts that are easy to get subtly wrong (session cookies, CSRF/origin checks, TOTP, WebAuthn, OIDC/SAML), while the authorization model — the product's actual differentiator — stays in OCSO code and tests. Better Auth is framework-agnostic, runs in-process on our Postgres with Drizzle, and needs no external identity service.

**Alternatives.** Keep extending the hand-built auth (every new factor and SSO protocol is security code we would own alone); Keycloak/Authentik/Zitadel (another stateful service to run in Compose and AWS, and a second user store); Auth.js (weaker email/password, 2FA and SAML story); Better Auth's `admin` plugin for user management (it brings its own `role` and ban semantics and endpoints that bypass OCSO's role matrix and audit — not used; ban = OCSO `status`, session revocation = OCSO).

**Deviations from the brief.**
1. Setup and user creation write Better Auth's rows (user + credential account + verification token) with Drizzle **inside OCSO's transaction** instead of calling Better Auth's server API: sign-up is disabled even server-side, and `internalAdapter.createUser` cannot join OCSO's transaction with the setup advisory lock and the audit record. Rows match Better Auth's model exactly; its endpoints consume them (tests prove sign-in, reset and invite acceptance).
2. The idle timeout is OCSO's (`last_active_at`) because Better Auth's sliding refresh would require re-issuing the browser cookie on API calls the BFF makes server-to-server.
3. `POST /v1/auth/login` is kept as a JSON sign-in for API clients (e2e and load scripts): it runs Better Auth's `/sign-in/email` in-process through the HTTP handler (same limits and hooks) and refuses accounts with two-factor.
4. OIDC discovery runs in OCSO (Better Auth's only trusts origins known at start-up); IdPs on private networks must be listed in `OCSO_AUTH_TRUSTED_ORIGINS`.
5. Email OTP as a second factor is not enabled (TOTP + backup codes only); SSO-only enforcement per domain is not built (password sign-in stays available to users who have one).

**Consequences.** Upgrading applies migrations 0014/0015: everyone signs in again once (old session tokens were only stored hashed); passwords keep working. `BETTER_AUTH_SECRET` becomes deployment bootstrap (Compose keygen generates it; rotating it signs everyone out and invalidates enrolled authenticators, whose secrets it encrypts). OIDC client secrets are stored in `auth_sso_providers.oidc_config` in Better Auth's format (database, not OCSO's secret store) — protect database backups accordingly. AWS: `/api/auth/*` must reach the web target group (default rule), not the API, so the client-IP header stays trustworthy (docs/operations/aws.md).

**Spec impact.** docs/15 (implementation notes), docs/operations/setup-guide.md §1, docs/operations/compose.md, docs/operations/aws.md.

---

## ADR-026 — Team-scoped virtual-agent ownership

**Status:** ACCEPTED (2026-09-22) — product decision: "each CS Lead only manages the agents that belong to their own team".

**Decision.** Virtual agents are owned by one or more teams (`agent_teams(agent_id, team_id)`, cascade on either side). People reach agents only through team membership (`principal.teamIds`, loaded per request by `loadPrincipal`). The rules live in the application services (`agents/access.ts` for scopes, `agents/owners.ts` for owner changes) so every surface — REST, Ask OCSO tools, realtime, seeds — inherits them:

- **Manage** (CS Lead: `agents.manage`, `prompts.edit/activate`, `agent_tools.manage`, `escalation.manage`, `reviews.manage`, `corrections.manage`, `evaluations.run`, business alert rules): the permission AND membership of an owning team.
- **Read**: `agents.read_all` (new; Tech Admin) → every agent. Otherwise `agents.read` → agents your teams own; principals without `agents.manage` (CS Execs) also read agents reachable through their teams' queues (default queue or an agent escalation rule targeting the queue), for display only.
- **Out of scope = 404** (`not_found`), never 403, so another team's agent does not leak. Lists filter silently; list filters naming a foreign agent (`?agentId=`) answer 404.
- **Owner changes** (`PUT /v1/agents/:id/owners`, also `teamIds` on `PATCH /v1/agents/:id`): `agents.assign_owner` (new; Tech Admin) may set any existing teams; a CS Lead may add or remove only teams they belong to, never another team's ownership. Always ≥ 1 owning team. A lead may drop all of their own teams only while another team still owns the agent (hand-off; they lose access). Creation requires ≥ 1 owning team, all the creating lead's teams. Audited as `agent.owners_change`; emits `config.changed{area:'agent_owners'}`.
- **Conversations**: `conversations.read_all` is replaced by `conversations.read_team` — assigned to me, OR the agent is owned by my teams, OR the queue is served by my teams (any control state). Exec scope (`conversations.read`) unchanged. The realtime SSE filter no longer short-circuits on a permission; it uses the same predicate, and agent-bearing alert/config events require the agent to be readable. Customers are visible iff a visible conversation exists (leads lost their "all customers" bypass; updates follow the same scope).
- **Analytics** aggregate over a scope subquery (`AnalyticsWindow.scope`): overview, comparison, series, corrections, escalation reasons, tags, lead home. Queue analytics list the queues a lead's teams serve or their agents route to, with window metrics over their agents' conversations; live queue columns stay queue-wide (counts only).
- **Alerts**: an alert with `context.agentId` is visible only to readers of that agent (list, get, counts, acknowledge, resolve, realtime); alerts about no agent keep audience visibility. Agent-targeted alert rules follow the agent; platform-wide rules (agentId null) stay visible to all readers of the kind.
- **Tech Admin**: reads all agents and reassigns owners (governance, e.g. a lead leaves); still no prompts/tools/go-live, and still no conversation content.

**Migration.** `0016_agent_team_ownership` creates the table and backfills: every existing agent is owned by the teams serving its default queue (`queue_teams`). Agents without a default queue, or whose queue has no team, stay unowned — visible to the Tech Admin only until assigned. The demo seed assigns owners explicitly (Maya → Cards & EMI, Riya → Hardship, Arjun → Sales) and adds a second CS Lead (Sales) so the scoping is visible.

**Why.** Larger deployments run several CS teams with their own agents; one lead editing another team's prompts or reading its transcripts is both an operational and a privacy problem. Many-to-many ownership covers shared agents without a separate "sharing" concept. 404 rather than 403 avoids enumerating other teams' agents.

**Alternatives.** Owner = a single team column on `virtual_agents` (no shared agents; reassignment becomes destructive). Per-user agent ACLs (does not survive people changes; teams already model the org). Deriving ownership from queues at read time (ambiguous for agents that route to several queues; a lead of a queue team could then edit prompts of agents they never owned).

**Addendum (2026-09-22) — SUPERSEDED by ADR-031** (a channel now names a router, not an agent). A channel answers as exactly one agent: `agent_channels` is unique per
channel (migration 0020) and `channels.default_agent_id` is kept in step with it, in both directions.
Attaching a channel another agent answers on is refused (`channel_in_use`); releasing a channel stops it
routing there. An agent may answer on many channels.

**Consequences.** A CS Lead in no team manages nothing: the web shows "Join or create a team to create agents". The lead who creates a team joins it; a lead adds and removes CS Execs (and leaves) only on teams they belong to, and creates new CS Execs only into those teams — the Tech Admin (`users.manage`) manages every membership, including adding other leads. Escalation rules are addressed through their own agent (`/agents/:agentId/escalation-rules/:ruleId` 404s for another agent's rule); platform-wide rules are read-only there. The audit log is team-scoped the same way (`audit.read_all` for the Tech Admin; otherwise events by teammates or on in-scope targets). Known gap: queue configuration remains shared (not team-owned).

---

## ADR-027 — Model discovery from the providers; prices from open-source model catalogs

**Status:** ACCEPTED (2026-09-22). Product owner direction: "how will I select the model, will I see the available models, how are we doing price monitoring?", followed by "model lists come from the providers themselves; no hand-maintained price table in code".

**Decision.**

1. **Model lists come from the providers.** `ModelProviderAdapter.listModels()` is optional and is implemented for every kind:
   - OpenAI and Anthropic: `GET /v1/models`.
   - Bedrock: ListFoundationModels plus ListInferenceProfiles, SigV4 or bearer API key, on the configured region.
   - Vertex: Model Garden publisher models for `google` and `anthropic`, using the configured service account or ADC.
   - Foundry: the deployments configured in settings (an inference key cannot list deployments).
   - Sarvam: its OpenAI-compatible `/models`, else the catalog.
   - DEV_SCRIPTED: its conventional ids.

   Listings use the adapter's credentials, fetch and deadline (15 s), through `CachedProviderAdapterSource`. `GET /v1/model-providers/:id/models` (providers.read) caches a listing per provider configuration for 10 minutes; `?refresh=true` needs providers.manage. A failed listing (bad key, outage) returns a typed `error` in a 200 body, never the key, so the picker can still take free text.
2. **Prices and model metadata come from open-source catalogs, not from code.**
   - **models.dev** (`https://models.dev/api.json`, MIT) is primary. **LiteLLM** `model_prices_and_context_window.json` (MIT) fills in models (or prices) models.dev lacks.
   - The mapping from OCSO kind and model id to catalog keys is explicit per kind. Keys must match exactly: no family guessing, Bedrock region prefixes kept, Vertex dateless Claude ids mapped to models.dev's `@default`, Foundry uses the declared underlying model. When a mapping is ambiguous, the model is not priced.
3. **Catalog refresh.**
   - The worker leader checks hourly and downloads when a source is a day old (an hour after a failure). A Tech Admin can refresh on demand (`POST /v1/model-catalog/refresh`, pricing.manage or providers.manage).
   - Downloads go through the SSRF guard (`@ocso/mcp` guarded fetch: public https only, DNS answers validated, 32 MB cap, 60 s deadline) plus a host allowlist (`models.dev`, `raw.githubusercontent.com`) checked on every redirect hop.
   - Each document is validated with zod and normalized (USD per 1M tokens, tiers). The latest snapshot per source is stored in `model_catalog_snapshots` (source, fetched_at, content hash, entries).
   - A document with too few models is rejected, and the previous snapshot is kept.
   - A normalized **vendored snapshot** ships in `@ocso/model-providers/catalog/` as the offline fallback (regenerate with `scripts/refresh-model-catalog.mjs`). Requests never fail because a catalog is unreachable.
4. **`model_pricing` stays the costing source of truth.**
   - Saving a profile adds a row for each target that no row prices yet, when the catalog prices it: `origin: 'catalog'` plus `catalog_source`, `catalog_provider`, `catalog_model_id` and `catalog_fetched_at`. This is audited.
   - A refresh moves catalog rows to the catalog's current price (effective now, audited as a system change).
   - An admin edit turns a row `manual`, and refreshes never touch manual rows.
   - Catalog rows match their exact model id only; manual rows keep the prefix rule.
   - Long-context tiers are stored in `model_pricing.tiers` and applied per request, the highest tier whose input threshold the request exceeded.
   - The usage recorder, telemetry and the budget alert share one selection and cost function (`selectPrice`, `usageCostMicros`).
   - Usage without a price is counted (`unpricedRequests`) and shown as "no price", never zero. `GET /v1/model-pricing/missing` lists the models in use without a price, with the catalog's offer.
5. **Budget alert.** `spend_budget_above` is TECHNICAL and optionally agent-scoped, with params `{ monthlyBudgetUsd, thresholdsPercent: [80, 100] }`.
   - Spend is month-to-date for the calendar month in the deployment timezone, from usage_events × model_pricing.
   - Each threshold fires once per month: month and budget are part of the fingerprint, and a threshold alert a person resolved does not reopen that month.
   - Alerts resolve at month rollover.
   - The body projects month-end spend at the month-to-date run rate. No rule is seeded.

**Why.** Prices change often, and a price table in code goes stale silently. The two catalogs are maintained in the open, cover every provider OCSO ships, and matched the vendors' own pricing pages for every OpenAI and Anthropic model we cross-checked on 2026-09-22 (PM/research/09 §7). Keeping `model_pricing` as the source of truth leaves admins in control: negotiated rates are manual rows. Listing models from the provider shows what the configured credentials can actually call, including fine-tunes, deployments and inference profiles.

**Alternatives.**
- A hand-maintained price table in code (rejected by the product owner: stale on day one).
- The Vercel AI Gateway model list or OpenRouter as data sources (rejected: hosted resellers whose published prices are their own, not the underlying provider's).
- Scraping vendor pricing pages (brittle, and against most sites' terms).
- `@aws-sdk/client-bedrock` for the control plane (aws4fetch, already used by the AI SDK Bedrock provider, is enough).

**Consequences.** Migration `0017_model_catalog_and_pricing_origin` adds `model_catalog_snapshots` and the `model_pricing` columns `origin`, `catalog_*`, `tiers` and `updated_at`. Existing rows become `manual`. The API and worker make outbound https calls to models.dev and raw.githubusercontent.com. Air-gapped deployments keep working on the vendored snapshot and set `OCSO_MODEL_CATALOG_REFRESH=false`, which turns refresh off in the API and worker. Known approximations are listed in PM/research/09 §8: 1-hour cache writes are costed at the 5-minute rate, batch, fast mode and data-residency uplifts are not modeled, and the budget alert re-prices older unpriced usage at average input size. The Vertex and Bedrock listings are built to their documented shapes and still owe a live check.

**Spec impact.** docs/06 (implementation notes), docs/11 (new alert condition), docs/operations/setup-guide.md §2 and §7, PM/research/09.

## ADR-028 — The plugin boundary: open kinds, self-describing plugins, one composition root

**Status:** ACCEPTED (2026-09-22). Product owner direction: "the plugin boundary is the product." An audit of the
code found about 40 places where core named a specific kind (closed kind unions and `z.enum`s, per-kind maps and
switches in the web app, `'WEBCHAT'`/`'DEV_SCRIPTED'`/`'OPENAI'`/`'IN_APP'` defaults, a WhatsApp-named template
subsystem) and one security bug: built-in agent tools bypassed tool authorization and audit.

**Decision.** OCSO is a core plus contracts. Core code never names a specific kind; per-kind knowledge lives in the
plugin and reaches the web app through `/kinds` endpoints.

1. **Kinds are open strings validated by registries.** `ChannelKind`, `ProviderKind` and `DestinationKind` are
   `string`, checked against a shared pattern (`/^[A-Z][A-Z0-9_]{1,39}$/`) and the registry (`has()`); application
   inputs use `z.string()` plus a registry check, never a closed enum. DB `kind` columns were already `text`; only the
   TypeScript column types widened. Channel kinds without adapters (SMS, RCS, VOICE, CUSTOM_APP) were dropped.
2. **Plugins describe themselves.**
   - Channels: `describe()` is required. The descriptor carries label, `mark`, `identitySetting`, `setupSteps`,
     webhook events, settings JSON Schema, secrets (generated or entered), inbound webhook segment, `embeddable` plus an
     `embed` hook (widget config, sessions, signed identity, attachment keys), `templates` terms, and
     `displayIdentity`. The registry refuses inconsistent plugins (embeddable without `embed`, `templates` without the
     template methods, bad marks or segments). `GET /v1/channels/kinds` serves it to any staff reader.
   - Model providers: `ProviderDefinition` carries `mark`, `cachingSummary`, `describeCaching`, `baseModel`,
     `devOnly` (gates registration and means "never priced") and its catalog mapping (`catalog.providers`,
     `candidates`) — the ADR-027 mapping switch moved into the definitions; catalog snapshots keep the catalog
     providers the definitions declare.
   - Alert destinations: `AlertDeliveryAdapter` carries `description`, `events` (replacing the `DESTINATION_EVENTS`
     map), a `configSchema` (JSON Schema), declarative secret requirements (`when`) and `summary(config)`;
     `GET /v1/notification-destinations/kinds`. The web form renders from the schema with the channel settings
     renderer.
3. **Capabilities, not kind names.** Message templates are a channel capability (the adapter implements the template
   methods): `message_templates.manage`, `message_template.status_changed`, `sessionWindow`, table
   `message_templates` (migration 0019 renames `whatsapp_templates`), `/templates` (the old path answers 308). The
   compiled prompt's channel block is generated from adapter capabilities (`maxTextLength`, markdown level, outbound
   parts) instead of text naming WhatsApp; with no channel the block is omitted. Masking of channel identities goes
   through the plugin's `displayIdentity`.
4. **Tools: one registry, one path.** Built-in tools are a first-party `ToolProviderSource` in the same
   `ToolProviderRegistry` as MCP. Every call — built-in or MCP — goes catalog entry → `authorizeToolCall` →
   `tool_calls` row → provider → result row and events. Only first-party tools may return effects (handoff);
   an MCP tool cannot shadow a built-in name; a first-party tool may not be SENSITIVE (it would wait for a human).
5. **Egress.** Channel adapters receive an injected `ChannelFetch`; the default is `NO_NETWORK`. The composition root
   passes the SSRF-guarded fetch (public https; the deployment's internal-host allowlist; response size cap).
6. **Drivers are registries too.** Email (resend, smtp, log), blob (local, s3), secrets (local, aws), queue
   (postgres, sqs) and deployment (compose, ecs) each have a driver definition `{ name, check?(env), create(env, deps) }`
   (email: `resolve`/`create`, `label`, `delivers`). `*_DRIVER` env settings are open strings with the same defaults;
   each driver checks its own settings; an unknown name fails start-up listing the registered drivers. Core asks
   drivers for capabilities instead of comparing names: `BlobStore.verifySignedGet`, `QueueAdapter.inDatabase` and
   `reportsOldestAge`, `DeploymentStatus.facts`, `EmailSender.delivers`.
7. **One composition root.** `@ocso/bootstrap` defines `OcsoPlugin { name, channels?, modelProviders?,
   alertDestinations?, toolProviders?, emailDrivers?, blobDrivers?, secretsDrivers?, queueDrivers?, deploymentDrivers? }`
   (contributions needing host services are factories) and `FIRST_PARTY_PLUGINS`. The api and the worker each provide
   one `PLUGINS` list and build every registry from it (the api used to build two provider registries).
8. **Enforcement.** `pnpm lint` runs `scripts/plugin-boundary.mjs`: it reads the plugin packages from
   `FIRST_PARTY_PLUGINS`, collects their kinds and driver names from source (no hand-kept list), and fails when core
   (apps, application, agent-runtime, domain, db schema, auth, events, prompt-compiler, web) contains a quoted kind
   literal or per-kind key. Seeds, tests, fixtures, migrations and `src/testing/` are exempt; a per-line
   `// plugin-boundary: allow <reason>` escape exists and is unused.

**Consequences.** A new channel, model provider or alert destination is one module behind its contract plus one
registration line; no core, database or web change. Plugins are still compiled in: the versioned
`@winsendotai/ocso-plugin-sdk` and a config-driven loader come next and plug into the composition root. Known
limits: driver-specific env settings are still declared in `@ocso/config`; alert conditions, scheduled tasks and
Ask OCSO tools have registries but are not plugin contributions yet; template draft rules still follow WhatsApp's
review rules; the widget API path `/public/webchat/:publicKey/*`
is shared by every embeddable kind; built-in tools have no `tools` rows, so they cannot be revoked per agent yet.

## ADR-029 — Per-user permissions: presets, grants and revokes, containment, reductions at once and increases through approval

**Status:** ACCEPTED (2026-09-23) — design in `research/11-governance-and-routing.md` §3 (owner decisions 1–3, 6–7). Extends ADR-025 (authorization stays in OCSO) and ADR-026 (team scoping). Wave 2 wires the approval spine (ADR on maker–checker) to the functions and hook named below. Revised the same day after an adversarial review (mixed change sets, inert users, SSO provisioning, streams, MFA, history).

**Decision.** A user's rights are a **preset** (Tech, Head, Lead, Service — never a level) plus per-user **grants** minus per-user **revokes**, inside the teams they belong to. A change is split: **what only takes access away applies at once, always; what widens it needs approval.**

- **Catalogue.** Every permission has `PERMISSION_INFO[p] = {label, group, description}` (`packages/auth/src/permission-info.ts`, 12 groups), tested for completeness. `GET /v1/permissions/catalogue` (any signed-in user) returns it with the presets that include each permission.
- **Presets** (`roles.ts`): Service ⊂ Lead ⊂ Head; Tech is separate. Invariants tested as before (§3.2).
- **Grants a preset can never hold** (`NON_GRANTABLE_BY_PRESET`, `@ocso/auth`): Tech can never be granted conversation content (all `conversations.*`, `customers.*`, human tools, Copilot, reviews, corrections), `prompts.edit` or business analytics. Checked when a change is made (400 `grant_not_allowed_for_preset`) and again when it applies, so no checker and no bootstrap self-approval can override it; a preset change to Tech cannot carry such a grant along. Tested: no preset holds what it can never be granted.
- **Overrides.** `user_permission_grants` (migration 0022): `effect GRANT|REVOKE`, `expires_at` (GRANT only — CHECK), `reason`, `proposal_id` (the approval that made the row effective; no FK because 0023 comes later), `created_by` (**the maker**; the checker is on the proposal), `cleared_at/by`. One live row per `(user, permission)` (partial unique index). **The database enforces the history:** trigger `user_permission_grants_history` allows an UPDATE only to set `cleared_at`/`cleared_by` once and refuses DELETE; `user_id` is `ON DELETE RESTRICT`. Active = not cleared and not expired; **expiry is computed on read, never swept.**
- **Principal.** `loadPrincipal` reads the user, their teams and their active overrides in one statement and sets `principal.permissions`. Nothing is cached: a grant or revoke applies from the next request; a preset change or deactivation also ends every session. **Open streams** (staff SSE, Ask OCSO) pass the principal they were opened with to `SessionLiveness.isLive(…, held)`, which (every `SESSION_STREAM_RECHECK_SECONDS`) closes them when the user lost a permission or a team — a revoke, an expired grant, a team removal — without ending the user's sessions.
- **Effective permissions everywhere a person is picked or checked.** `holdsPermissionSql(p)` (preset without an active revoke, or an active grant) drives handoff routing eligibility (`conversations.read` and `conversations.reply`), replacing the preset list; the MCP OAuth callback loads the full principal; **MFA follows rights**: `mfaRequiredFor(role, permissions, requireMfaRoles)` also requires a second factor of anyone granted a permission that a listed preset holds and their own preset lacks (auth guard, auth policy plugin and stream liveness all pass the effective set).
- **Split and classification** (pure, browser-safe, `@ocso/auth`): `planRightsChange(before, change)` → `{direct, proposed}`. Reductions — REVOKE, CLEAR of a grant, shortening a live grant, leaving a team, a downgrade to a preset contained in the old one, disabling — go to `direct`; the rest is `proposed` when `classifyRightsChange` finds an **increase**: a permission gained, a team joined, a grant new or lasting longer, or activation. A never-approved (**PENDING_APPROVAL**) user is a draft: preset and team edits apply directly. An approved user **stays governed while DISABLED**: an upgrade or team added while disabled is an increase, so disable → upgrade → re-enable cannot smuggle an upgrade past a checker.
- **Apply functions** (what approval runs): `applyPermissionChangeSet(tx, actor, {userId, makerId?, role?, teams?, ops, reason}, {proposalId?, maker?, approvalSkipped?})` and `activateUser(tx, actor, userId, {proposalId?, expected?, makerId?, approvalSkipped?})` (`packages/application/src/identity/permissions/apply.ts`). Everything is decided against the state read **under the user's row lock**: for a direct write the caller passes `maker` and the maker rules re-run there; for an approval the stored `makerId` is **re-validated at activation** (`maker_not_active`, `maker_no_longer_eligible`); structure (teams exist, grants in the future, break-glass) and non-grantable grants are always checked. Lock order is always user row, then the `ocso:tech-admins` advisory lock.
- **User proposals bind rights.** The `user` payload (CREATE a pending user, ACTIVATE a disabled one) is `{userId, makerId, rights: {role, teamIds, overrides}}` (canonical snapshot). `activateUser(…, {expected})` refuses any other state (`user_changed_since_proposal`): the checker approves exactly what they saw.
- **Gate.** `IdentityApprovals.submit` (API token `IDENTITY_APPROVALS`, `null` until wave 2) receives `{objectKind: 'user'|'permission_change', objectId, action: CREATE|UPDATE|ACTIVATE, payload, approval, reason}`; it runs after the caller committed (an immediate bootstrap approval takes the same row lock). `proposeIncrease` refuses a checker who is the maker or the target (400 `checker_not_eligible`); the port's documented contract requires the adapter to enforce checker eligibility and the §4.2 bootstrap preconditions. Without a checker (or spine): **409 `approval_required` `{objectKind, action, objectId}`** — and when the request also carried reductions, they have applied and the 409 says so (`details.applied`, message). `IdentityGovernance.onDirectRightsChange(tx, actor, {userId, kind})` is called under the row lock before every direct rights change or discard: the hook where wave 2 voids (or refuses while open) that user's proposals.
- **Makers** (`assertMayChangeRights`): grants/revokes need `permissions.manage`; creating users, presets and memberships need `users.manage` or `users.manage_team`. **Never self** (leaving your own team is allowed; nobody adds themselves to a team, even where approval is skipped). Without `users.manage`: the target shares a team with the maker (before or after), **a new user must be placed in one of the maker's teams**, memberships change only on the maker's teams, and containment before and after. The creator of a new team joins it without approval: the team owns nothing yet, so joining widens nobody's reach.
- **Users.** `POST /v1/users` writes the user **PENDING_APPROVAL**: inert; password sign-in answers 403 `ACCOUNT_PENDING_APPROVAL` (only after the right password), SSO `account_pending_approval`; 201 with `approvalRequired`, or 202 with `proposal`; if a named checker cannot be submitted, the row is removed (nothing left behind, email free). `PATCH /v1/users/:id` on a pending user edits the draft and, with `approval` or `status: 'ACTIVE'`, submits its creation; a pending user cannot be disabled; `DELETE /v1/users/:id` discards a pending user (never one with grant history). In development, PATCH ACTIVE on a pending user activates it and sends the invite. On approved users PATCH splits as above (re-enabling goes alone: `activate_alone`); profile fields are never gated. `POST /v1/teams/:id/members` of an approved (ACTIVE or DISABLED) user is an increase (202/409), decided under the row lock; removal is immediate.
- **SSO auto-provisioning** is a user creation: on a governed deployment the resolver writes the new Service member PENDING_APPROVAL itself (Better Auth would roll it back with the refused session), audits `user.create` with `provisionedBy: 'sso'`, and refuses that sign-in; once approved, the next SSO sign-in links them.
- **API.** `GET /v1/permissions/catalogue`, `GET /v1/users/:id/permissions` (`permissions.read`, team-scoped unless `users.manage`, else 404), `POST /v1/users/:id/permission-changes` (`permissions.manage` | `users.manage` | `users.manage_team`) → 200 `{applied, direction, lost, teamsRemoved, sessionsEnded}` · 202 adds `proposal, gained, teamsAdded` · 409; `DELETE /v1/users/:id` (`users.manage` | `users.manage_team`, pending only). No new public route.
- **Skipping approval.** `OCSO_DEV_SKIP_ACCESS_APPROVAL=true` is refused when `NODE_ENV=production`, accepted only when `NODE_ENV` is **set explicitly** to development or test (it defaults to development), and logged as a warning at start-up. The **demo seed** also creates its people ACTIVE, even under `NODE_ENV=production` in Compose: it is an operator bootstrap standing in for the first approvals, like the grandfather migration (0031). Every skipped approval is audited with `approvalSkipped: 'dev_flag' | 'demo_seed'` (and in the summary), so the exception report can list it. Grants are never skipped.

**Deviations from the design, and why.**
1. *User creation answers 201 (pending) instead of 409 without `approval`, and the 202 body is the user with `proposal` (flattened), not `{user, proposal}`.* The pending row is an inert draft (§4.1 "drafts are written directly"); it can be submitted later (PATCH with `approval`) or discarded, so nothing gets stuck, and a 409 that commits a row would invite duplicate retries.
2. *No separate `INDEX (user_id) WHERE cleared_at IS NULL`.* The partial unique index on `(user_id, permission)` already serves that lookup.
3. *REVOKEs cannot expire.* A lapsing revoke would restore rights without approval.
4. *Lengthening a grant is an increase* even when today's set is unchanged; shortening applies at once.
5. *Re-enabling goes alone* (`activate_alone`); its reductions still apply.
6. *Break-glass also counts `users.manage`.*
7. *The `permission_change` payload is the change set itself* (11b's "grant rows with an effective-from column" is not used): approval applies the stored change set to the state at that moment, under the row lock, re-validating the maker.
8. *Alert audiences stay role-targeted.* An alert rule's `audienceRoles` is delivery targeting chosen by its author, not authorization; visibility already requires the effective read permission (`readableKinds(principal)` uses `can`), so a revoke hides alerts and a grant alone does not subscribe anyone to role-targeted alerts.

**Consequences.** Every place that authorizes through `can(principal, …)` honours grants and revokes. `Principal.permissions` stays optional for legacy constructors (seeds, tests); `can()` falls back to the preset only there. A reduction reaches open streams within one recheck interval rather than instantly. Handoffs already assigned to someone whose `conversations.read`/`reply` is revoked are not requeued automatically (routing follow-up). Until wave 2 registers the `user` and `permission_change` descriptors — calling `activateUser(tx, actor, payload.userId, {proposalId, expected: payload.rights, makerId: payload.makerId})` then `UserService.sendActivationInvite` (deferred), and `applyPermissionChangeSet(tx, actor, payload, {proposalId})` — no increase can apply in a governed deployment, so the grandfather migration (0031) must mark existing ACTIVE users approved; wave 2 also fills `onDirectRightsChange` and lists `approvalSkipped` audit rows in the exception report.

**Alternatives.** Classifying a change set as a whole (rejected in review: a revoke would wait for the grant beside it). Treating disabled users as drafts (rejected: disable → upgrade → re-enable bypassed the checker). Ending every session on any reduction (logs people out for a revoke; stream liveness closes only what the reduction affects). Custom roles per deployment; levels for approval rules; sweeping expired grants — as before.

## ADR-030 — Maker–checker spine: proposals, named checkers, hashes, one composition point

**Status:** PROPOSED (2026-09-23) — design in `research/11-governance-and-routing.md` §4 and `research/11b-approvals-detail.md` (11 wins where they differ). Wave 1 builds the spine and the reference kinds `agent` and `prompt_version`; wave 2 registers the remaining kinds.

> **Awaiting owner ruling (integrator).** Two deviations below are built but not yet signed off:
> **deviation 10** — Service members hold `approvals.read` and see their team's proposals read-only on `/approvals`;
> **deviation 11** — a platform-wide fallback checker is kept (when nobody in the owning teams can check, any ACTIVE
> holder of the check permission can; bootstrap only when nobody else anywhere is eligible). Both stay as built until
> the owner rules.

**Decision.** Every change to live configuration is a *proposal* checked by a named second person. Approval state is derived from two new tables, never stored on the configuration object.

- **Data (migration 0023).** `approval_proposals` (one row per change: object kind + id, action CREATE|UPDATE|DELETE|ACTIVATE, status SUBMITTED|APPROVED|REJECTED|WITHDRAWN|BLOCKED|VOID, origin USER|MIGRATION, revision, raw `payload`, `before_snapshot`/`after_snapshot`, `content_hash`, `dependency_keys`/`dependency_hash`, `team_ids`, title, reason, maker, checker, `checker_valid`, `edited_after_submission`, `bootstrap`, warnings, notification/decision/activation stamps). CHECKs: maker ≠ checker unless `bootstrap`; an open proposal has both; the decider is not the maker unless `bootstrap` or the status is WITHDRAWN/VOID. Trigger `ocso_guard_approval_proposal` freezes a proposal once decided: rows are never deleted or truncated, are created SUBMITTED (grandfathered MIGRATION rows excepted), maker/object/action/origin never change, and after the decision only APPROVED→BLOCKED before activation, `activated_at` (once), `activation_attempts`, `notified_at` and `updated_at` may change. Partial unique index `(object_kind, object_id) WHERE status='SUBMITTED'` = one open proposal per object. `approval_decisions` is the append-only history (SUBMIT, EDIT, APPROVE, BOOTSTRAP_APPROVE, REJECT, WITHDRAW, REASSIGN, BLOCK, VOID, ACTIVATE; frozen diff, warnings, `bulk_batch_id`, the audit event id), protected by its own trigger function `ocso_reject_decision_mutation` (UPDATE/DELETE/TRUNCATE); its FK to the proposal is ON DELETE RESTRICT. `deployment_settings.approval_age_warning_hours` (72). "Approved" = an APPROVED proposal exists; "pending" = the open one; "activating" = APPROVED with `activated_at` NULL.
- **Descriptors.** Each kind registers an `ApprovalDescriptor` (`packages/application/src/approvals/contract.ts`): label, actions, `makePermission(action)`, one `approvals.check.*` permission, payload schema, `project`/`projectAfter` (checker-visible projections, never secrets), `teamIds`, `dependencies` (`kind:id@updated_at`), `assertVisible` (ADR-026 read scope, 404), optional `assertMakeable` (write scope for proposing; default `assertVisible`), optional `hashBasis` (what the content hash covers — identifiers, not display names; default the projection), optional `lock` (the advisory key + row locks shared by every writer of that configuration; default `<kind>:<id>`), optional `related` (other objects whose open proposal also locks this one), optional `eligible` (replaces the team rule and the fallback) and `requiresApproval` (replaces the default gate), `validate`, `activate` (DONE or DEFERRED), optional `activateDeferred` (must be idempotent at the provider where it can), `liveObjects`, `title`, optional `hashExclude`. The registry refuses duplicates, runtime kinds (conversation, handoff, interaction, assignment, tool_call) and check permissions outside `APPROVAL_CHECK_PERMISSIONS`. Core never switches on a kind.
- **One composition point.** `createApprovalRegistry(deps)` (`approvals/composition.ts`) registers every descriptor; the API (`ApprovalsModule`, global, token `APPROVAL_REGISTRY`), the worker (`WorkerApprovalsModule`) and the demo seed all build it there, and `coverage.test.ts` pins the reviewed kind list. Wave-2 kinds add a descriptor and one `register` line; deps they need (channel registry, email) are passed through `ApprovalRegistryDeps`.
- **Gate and lock.** Default rule (`guard.ts`): once an object has an approved proposal every write to it is a proposal; ACTIVATE and DELETE always are; a never-approved object is a draft written directly. Services call `assertChangeAllowed(tx, descriptor, id, action)` inside the write's transaction after locking the row: 409 `approval_open` while a proposal on the object or a related object is open (or an approved one is still activating), 409 `approval_required` when the write must be a proposal. Writes that are never proposals but change what a checker sees call `assertUnlocked` (agent owners, tool grants, escalation rules: `assertAgentUnlocked`). Stop actions (agent pause today; channel/router/connection disable, grant removal and right decreases in later waves) never call the guard and work while a proposal is open.
- **Submission UX.** Approvable endpoints accept `approval: {checkerId, reason} | {bootstrap: true, reason?}`. `requestApproval()` routes: draft → apply (unchanged response); needs approval without `approval` → 409 `approval_required {objectKind, objectId, action}`; with it → `ApprovalService.submit` with the request body as payload → **202 `{proposal}`** (`approvalResponse` helper). `POST /v1/approvals` remains for kinds with no write endpoint.
- **Submit.** Descriptor action + make permission + write scope (`assertMakeable`); payload parsed by the descriptor; the descriptor's lock (advisory `hashtext('ocso:approval:<key>')` + row locks) then the open check across related objects and the unique index; checker eligible (ACTIVE via `loadPrincipal`, holds the check permission, not the maker, shares a team with the object or the object is platform-wide; or the descriptor's rule); snapshots, team ids, dependencies, hashes, title; an UPDATE whose diff is empty is refused (400 `no_changes`); hard validation problems refuse the submit (400 `validation_failed`); SUBMIT decision + `approval.submit` audit + `approval.requested` event in the same transaction; `approval.notify` published after commit.
- **Eligibility and bootstrap.** Default eligibility: ACTIVE, holds the check permission, not the maker, and the proposal is platform-wide or shares a team with them; when nobody in the owning teams (maker excluded) is eligible, any ACTIVE holder of the check permission is — the platform-wide fallback. Bootstrap is allowed only when nobody else anywhere is eligible and the maker holds the check permission; the proposal is inserted with `checker_id = maker_id`, `bootstrap = true` and approved at once (`BOOTSTRAP_APPROVE` decision).
- **Decide.** In one transaction: the proposal `FOR UPDATE`, then the object's lock (the one submit and the direct writes take), and only then anything is read. Open; the decider's rights re-read from the database (`loadPrincipal`) — holds the check permission, is not the maker (403 `self_review`), is the named checker (403 `not_checker`; `approvals.reassign_any` only reassigns), and is still eligible with `checker_valid` set (403 `checker_invalid`); being the named, eligible checker is what lets a fallback checker from another team decide from the proposal's projection. APPROVE only: the content hash recomputed from the live object must equal both the stored one and the one the checker sent (409 `content_changed`), and the live dependency hash must equal the one stored at submit (409 `dependency_changed`; the maker refreshes by editing). REJECT skips both hash checks — rejecting stale content is always safe, so a drifted proposal can always be closed. APPROVE re-runs `validate`: problems → BLOCKED with a BLOCK decision, committed, object untouched; otherwise APPROVE decision, `descriptor.activate` in the same transaction (the descriptor writes the object's own audit row and cache bump), then ACTIVATE decision (DONE) or `approval.activate` after commit (DEFERRED). A genuine error in `activate` rolls everything back and the proposal stays open.
- **Deferred activation.** Worker consumer `approval.activate` → `finishActivation`: one runner per proposal — a transaction holds `pg_try_advisory_xact_lock('ocso:approval-activate:<id>')` for the whole attempt (a second consumer, e.g. SQS redelivery during a slow provider call, gets SKIPPED; a crashed runner's lock dies with its connection; the provider work runs on other connections); skip unless a USER proposal is APPROVED with `activated_at` NULL; re-check both hashes and validation (any mismatch → BLOCKED before any provider call); count the attempt; `activateDeferred`; stamp `activated_at` + ACTIVATE decision. A non-retriable error, or the 5th attempt, blocks; a transient one retries through the queue.
- **Edits, bulk, reassignment.** The maker edits the proposal (never the locked object): revision+1, hashes recomputed, `edited_after_submission` kept until decided. Bulk approve (≤ 50, approve only) runs each item in its own transaction through the same path with its own decision row and a shared `bulk_batch_id`; any blocking warning (all but `aged`), hash mismatch, failed validation or foreign item is skipped with a code. Reassignment needs `approvals.reassign_any` or the kind's check permission, and the new checker must be eligible.
- **Sweeps (leader).** `approval-checker-sweep` (300 s) flags/unflags `checker_valid` and emits `approval.checker_invalid` — it never reassigns; `approval-notify-redispatch` and `approval-activate-redispatch` (300 s) republish lost jobs; `approval-void-orphans` (900 s) voids open proposals whose object is gone or whose maker is no longer ACTIVE or no longer holds the make permission. Publish failures are logged (never swallowed silently); a REQUESTED notice the notifier cannot deliver (checker not ACTIVE, permanent email refusal) is stamped so redispatch stops; the `notified_at` stamp is conditional on the checker and revision the job emailed, so a racing reassignment still gets its email. Withdraw publishes the DECIDED notice (the checker is emailed).
- **Void.** `POST /v1/approvals/:id/void {reason}` (`approvals.reassign_any`): an open proposal nobody can decide any more is closed with a VOID decision row and an audit event; nothing is applied.
- **Scope and notifications.** Lists and reads: `approvals.reassign_any` → all; otherwise maker or checker = me, or the proposal's teams overlap mine, or platform-wide when I hold a check permission; out of scope = 404. Opening one (open or decided) additionally needs the object's own visibility while the object exists, except for its maker and named checker — so a team that lost ownership stops reading the snapshots. `GET /checkers` needs a make permission and write scope; candidate `email`/`role` only with `users.read`. Realtime approval events reach the maker, the named checker and `approvals.reassign_any` holders. Email (`approvalEmail` over the shared layout) is sent by the worker: the checker on request, the maker on decision, Tech and the maker when the checker becomes invalid. Audit rows use target type `approval`; the audit store's team scope (ADR-032 `auditTeams`) reads the proposal's `team_ids`.
- **Reference kinds.** `agent`: ACTIVATE (first go-live and resume from PAUSED), UPDATE (patch without owning teams; owners stay a governance action on `PUT /owners`, locked while a proposal is open), DELETE (`agents.delete`, refused for LIVE agents and agents with conversation history; clears a legacy `channels.default_agent_id`); pause stays immediate with `agents.pause`. The projection shows slug, names, the active prompt's full text, tool grants and escalation rules (so "Take X live" shows everything going live); the hash basis covers ids, slug, prompt version, owning team ids, grants and rule versions — not names, reached channels or status. Proposing needs owning-team write scope. `prompt_version`: ACTIVATE, gated by the agent's approval (a draft agent's prompts activate directly); it shares the agent's lock, and an open proposal on the agent or any version locks all of them (one open prompt activation per agent). Both check with `approvals.check.agents`. Web: `/approvals` (Awaiting me · Sent by me · All open · Decided, drawer with diff, decision form carrying the hashes, bulk bar, reassign), `SubmitForApprovalModal`, `useApprovalRequest` (the approval-required interceptor), `ApprovableButton`, `PendingBadge`, approval notices.

**Why.** "Every change has a second pair of eyes" is only true if the rule lives in the write path, the checker sees exactly what will change, and nothing can drift between the look and the effect. Deriving approval from one table (instead of 13 status columns) keeps one truth; hashes make "approve what you saw" mechanical; approve-and-activate in one transaction removes the stale-approval window; the descriptor registry keeps the spine kind-agnostic like the plugin registries of ADR-028.

**Alternatives.** An `approved` flag per table (duplicated state, the `channels.default_agent_id` lesson); letting the object drift and voiding the approval (locking is simpler to reason about and to audit); approval by level or preset (the owner decided approval rules are permissions); a background job per bulk item (the checker must see per-item outcomes synchronously).

**Deviations from the brief (smallest correct changes).**
1. Snapshots are plain JSON, not `sanitizeForAudit`'d: its key heuristics blank legitimate configuration (`maxOutputTokens`, `sessionWindow`) and truncate prompt text at 2 000 characters — exactly what a checker must read. Descriptors guarantee projections carry no secrets; payloads are pinned secret-free per kind by `payload-redaction.test.ts`.
2. The content hash covers a descriptor's `hashBasis` (identifiers) rather than the checker projection (names), and the agent's basis leaves out `status`, so pausing Maya or renaming a queue elsewhere does not void "change Maya's hours"; activation re-validates against the live status anyway. (`hashExclude` remains for kinds without a basis.)
3. *(Withdrawn after review — now as 11b.)* Approval compares the live dependency hash with the one stored at submit; an optional `dependencyHash` in the request must equal the stored one too. A drifted proposal is refreshed by the maker's edit, or rejected (reject needs no matching hashes).
4. `422` in 11b becomes `400 validation` (`checker_not_eligible`, `bootstrap_not_allowed`, `validation_failed`, `invalid_payload`): OCSO's error categories map 422 to `tool_rejected` only.
5. `GET /v1/approvals/checkers` returns `{checkers, bootstrapAllowed, checkPermission}` (the modal needs to know whether to offer bootstrap); added `GET /v1/approvals/state`, `GET /v1/approvals/:id/checkers` (reassign picker) and `POST /v1/approvals/:id/withdraw` body `{reason}`.
6. The decision re-reads the decider's rights from the database, not only the request principal, so a checker disabled or stripped mid-session cannot decide even with a live principal object (defence in depth; the sweep only flags).
7. `prompt_version` ACTIVATE is gated by its agent's approval, not always (descriptor `requiresApproval`): a draft agent is inert and its go-live approval shows the active prompt.
8. Deleting an agent physically deletes it, which the prompt-version immutability trigger would forbid. Migration 0023 re-creates `ocso_guard_prompt_version()` to let an agent's versions go only when an APPROVED, `origin='USER'` DELETE proposal for that agent exists (proposals are frozen once decided, so this cannot be forged by UPDATE; the approval row stays as the record after the agent is gone); agents with conversations cannot be deleted. The UPDATE rules are unchanged.
9. Approve on the queue takes an optional reason; reject requires one (11b required it for both).
10. The Service preset holds `approvals.read`, so a Service member reads `/approvals` (their team's proposals, nothing to decide) instead of `NotPermitted` as 11b's Playwright list assumed. 11b contradicts itself here ("a Service member sees only Sent by me" in its test list vs the `approvalScope` formula); the build follows the formula — Service members already read their team's agents (ADR-026), so seeing the proposals on them adds nothing — **owner ruling requested**.
11. **Platform-wide fallback checker** (not in 11/11b; review finding): with team-scoped eligibility and one Head per team, bootstrap would be the normal path, and a Head could manufacture it by reshaping owners or membership. When nobody in the owning teams can check, any ACTIVE holder of the check permission can; bootstrap only on a deployment with no other holder at all. **Needs owner sign-off.**
12. Admin void (`POST /:id/void`, `approvals.reassign_any`) and the sweep voiding proposals whose maker left or lost the make permission (11b had no way out of a proposal nobody can decide).
13. Proposal rows are frozen once decided (trigger + decider CHECK), and the decisions FK is RESTRICT (11b protected only `approval_decisions`).
14. REJECT skips the hash checks (11b did not say; requiring them made undecidable proposals).
15. `GET /checkers` needs a make permission and write scope, and hides `email`/`role` without `users.read`.

**Consequences.** Going live, resuming, deleting and changing a live agent now need a second person: the API answers 409/202 and the UI asks for a checker. Seeds and test fixtures take agents live through proposals: the demo seed has each Head check the other Head's agents (no bootstrap rows); e2e setups create a checker Head (`e2e/approval-setup.ts`); only the single-checker `agents.spec` deployment still bootstraps. The internal-agent `set_agent_status LIVE` and `update_agent` tools meet `approval_required` for live agents (they surface the 409; routing them into proposals is future work). Until migration 0031 grandfathers existing live configuration, agents that are LIVE/PAUSED from before 0023 count as never approved: they change directly (only go-live is gated). 0031 (the grandfather) must insert, per kind, APPROVED `origin='MIGRATION'` rows with `activated_at` set (the proposal trigger admits only MIGRATION rows inserted non-SUBMITTED); any action works for "approved" (`isApproved` ignores it) — follow 11b's `'CREATE'`; MIGRATION rows are never finished by the deferred worker.

**Spec impact.** docs/14 (approval write contract, `/v1/approvals`, realtime events), docs/15 (maker–checker governance notes), docs/05 (prompt activation). README/PM docs are merged by the integrator.

### ADR-030 amendment A (2026-09-23) — platform objects under maker–checker (wave 2, COVERAGE-PLATFORM)

**Status:** PROPOSED (2026-09-23; revised after adversarial review the same day). Amends ADR-030 (the approval spine) and fills in PM/research/11 §4 for platform objects. Migration `0029_approvals_coverage_platform.sql`.

**Decision.** Nine platform kinds are registered in `approvals/composition.ts` through `platformApprovals(deps)` (`settings/platform-registry.ts`). They follow the spine's lifecycle rule:

- A **draft** is written directly and is inert.
- **ACTIVATE** and **DELETE** are always proposals.
- Once an object is approved **or live**, every change is a proposal: 202 with `approval`, or 409 `approval_required` without it. "Live" is the same per-row test as `liveObjects()` (`settings/platform-live.ts`), so a live object with no approval on record (an upgraded deployment before 0031 runs, or anything 0031 missed) is never treated as a draft. Every platform descriptor's `requiresApproval` and every direct write path (`assertPlatformWrite`) use it.
- **Stops** (disable) are immediate and are never locked by an open proposal. Resuming is an ACTIVATE.
- **Runtime work** (deliveries, probes, OAuth token refresh, catalog refresh) is never approved.

Every kind except `channel` is checked with `approvals.check.platform`. Channels are checked with `approvals.check.channels`.

| kind | draft / live | ACTIVATE | notes |
|---|---|---|---|
| `channel` | `status` DRAFT / ACTIVE (DISABLED = stopped) | go live (resume from DISABLED) | Config is validated on save and again at activation. DELETE is refused while ACTIVE or when conversations exist. |
| `model_provider` | `enabled` false / true | enable | Created disabled. Direct delete answers 409; delete is a proposal. |
| `model_profile` | **live = in use** (no status column) | "Approve for use": records approval, changes nothing | In use means referenced by a LIVE/PAUSED agent (model, summarizer or copilot), by `deployment_settings.internal_agent_profile_id`, or by a CLASSIFY step of an ACTIVE router's active version. It is governed once approved or in use. **Nothing can put an unapproved profile in use**: the agent descriptor (ACTIVATE, and any change of a non-draft agent), the settings descriptor (`internalAgentProfileId`) and the router descriptor all report `model_profile_not_approved` (soft `_pending` while its approval is open, hard at activation). |
| `model_pricing` | new `status` DRAFT / ACTIVE | apply the price | Pricing ignores DRAFT rows (`selectPrice`). Catalog rows are refreshed directly by the system (the refresh skips a row an open proposal locks); a person's edit to one is a proposal and makes it `manual`. **Exemption:** "Add from catalog" (`addFromCatalog`) inserts a catalog-origin row directly. The person picks a model and chooses no value; the row is exactly what the system adds on its own when a profile is saved (`ensureCatalogPrices`), and later refreshes keep it in step with the catalog. |
| `mcp_connection` (shared/template) | `approved_at` null / set, not DISABLED | **deferred**: the worker probes the server and compares its tool-set hash with the one in the approved snapshot (`afterSnapshot.toolSetHash`); missing or different → BLOCKED | A disable after the ACTIVATE was submitted wins: validation reports `mcp_disabled_since_submit` and the finish re-checks it under the row lock. `settled()` recognises a go-live that committed before the spine's stamp (approvedAt ≥ submittedAt, approvedBy = checker), so a crash there finishes as ACTIVATED. OAuth on a governed connection is direct only as a **re-authorization** (same issuer and client, scopes within those granted; `assertOAuthAllowed`), checked when the flow begins and again under the lock when it completes; anything else is 409 `approval_required`. A draft authenticates freely unless a proposal locks it. Personal connections are out of scope. |
| `notification_destination` | `enabled` false / true | enable | |
| `webhook_subscription` | `enabled` false / true | enable | Secret rotation stays **direct**: it is a revocation. |
| `sso_provider` | new `status` DRAFT / ACTIVE / DISABLED | go live | Sign-in through a non-ACTIVE provider is refused (`sso_provider_inactive`). DELETE also removes the provider's linked `auth_accounts`. |
| `deployment_settings` | always live (singleton id `00000000-0000-4000-8000-000000000001`) | — (UPDATE only) | Payload sections are `deployment`, `visibility`, `retention`, `workers`, `mfa`, `approvals` and `audit`. Several sections go in one proposal, and each gets its own audit row. |

**Secrets.** Secrets never go into a payload, a snapshot, a decision or an audit row. A replacement value is staged at submit as a new `SecretStore` ref; the payload carries only `{field, ref}` pairs, and the projection shows "new value (proposed)". The ledger `approval_secret_refs` (0029, `settings/secret-refs.ts`) owns them:
- **STAGED** rows are written when a value is staged: `(ref, object kind, object id, maker)`. Every descriptor's `validate` refuses a payload ref that is not STAGED for that object by that proposal's maker (`secret_ref_not_staged`, hard). Refs are readable elsewhere (`GET /v1/channels`, `/v1/secrets`), so without this check a generic submit or edit could point one object at another object's live credential.
- Activation **claims** the staged refs (the rows are removed; the refs now belong to the object) and **releases** the refs it stopped using: a RELEASED row written in the activation transaction. No secret is deleted inside that transaction, because the store is not transactional. A rollback takes the RELEASED row with it, so the live object never points at a deleted secret.
- The leader task `approval-secret-sweep` (every 60 s) deletes RELEASED secrets, which are only ever committed rows. It also deletes STAGED ones older than 15 minutes that no open or activating proposal on their object carries: rejected, withdrawn, voided, blocked, or replaced by an edit.
- A submit that fails unstages at once.
- Direct (draft) paths never rotate in place. A provider credential is a new secret, and the old one is deleted after the commit.

**Settings rules.**
- Only one settings proposal can be open at a time. The maker edits it to add a section.
- The `workers` section also needs `system.configure` from the maker, and is validated as a whole (merged with the current values).
- A retention below the audit floor is refused at submit (`invalid_payload`, by `RetentionInput`).
- Makers: holders of `deployment_settings.manage` or `system.configure` (`mayMake`). Validation then requires `system.configure` for the workers section and `deployment_settings.manage` for every other section.
- The direct `SettingsService.updateDeployment/updateWorkers` and `AuthPolicyService.update` paths now answer `approval_required`.

**Bootstrap.** A sole Tech can bootstrap every `approvals.check.platform` kind (self-approval, recorded as `BOOTSTRAP_APPROVE`). This is refused as soon as another eligible checker exists.

**Channels:** the spine gains an optional descriptor field `bootstrapPermission` (contract.ts, access.ts `bootstrapAllowed`, additive). The channel descriptor sets it to `approvals.check.platform`. When nobody anywhere holds `approvals.check.channels`, a Tech may bootstrap a channel, recorded the same way. As soon as any Head (or anyone granted `check.channels`) exists, the Head checks it. This lets a fresh single-Tech deployment, such as the live demo, take its first channel live without widening the Tech preset.

`message_template` (COVERAGE-BUSINESS) can opt in the same way.

**Permissions.** `pricing.manage` was added to `APPROVAL_MAKE_PERMISSIONS`.

**Create-and-activate.** `POST` with `approval` creates the draft and submits its ACTIVATE. When that submit is refused (checker not eligible, bootstrap not allowed, validation), the answer is **201** with the draft and `activationError`, never an error that leaves an unknown draft behind. The client retries the activation on that id.

**Installed configuration.** The default in-app notification destination that setup installs gets `recordInstalledApproval`, like the default alert rules. The exception report is empty right after setup.

**Deviations from research/11.**
1. Profile liveness is derived from use, not from a status column.
2. `model_pricing.status` and `auth_sso_providers.status` are new columns (0029). Existing rows default to ACTIVE; new SSO rows default to DRAFT.
3. The settings singleton id is `…0001`, because `z.uuid()` rejects the all-zero id.
4. MCP ACTIVATE is deferred, with a tool-set-hash probe.
5. `approval_secret_refs` (0029) is a new table: the secret-ref ledger described above.
6. The descriptor contract gains `bootstrapPermission` (optional).

**Known gaps / for the integrator.**
- **Bootstrap after the only other checker is disabled.** A Tech can disable the only Head (a stop, immediate by spec) and then bootstrap. The spec (§4.2, decision 6) allows bootstrap whenever nobody else is eligible, and every cooldown considered deadlocks a legitimate single-Tech deployment for the whole window, because re-enabling or inviting a Head is itself a proposal. What exists today: each such approval is `BOOTSTRAP_APPROVE` in the exception report, and the disable is audited. A rule is a spine/policy decision (access.ts), so it is left to the integrator.
- **One open settings proposal.** Only its maker can edit or withdraw it; voiding needs `approvals.reassign_any`. Per-section locking or a withdraw-by-any-manager rule is a spine change and is not done.

### ADR-030 amendment B (2026-09-23) — business and identity kinds on the spine (wave 2, COVERAGE-BUSINESS)

**Status:** PROPOSED (2026-09-23), wave 2. Amends ADR-030 (maker–checker spine) and closes the wave-2 hooks of ADR-029 (per-user permissions).

**Decision.** Seven kinds register at the one composition point (`createApprovalRegistry({ business })`, through `approvals/business-kinds.ts`), each following the rule for every kind: drafts (never approved) are written directly and are inert; ACTIVATE and DELETE always need a proposal; once approved every change is a proposal (202 with `approval`, 409 `approval_required` without); stop actions are immediate and never locked by an open proposal; resuming a stopped object is ACTIVATE.

| kind | object | make / check | never-approved state | actions | stop (immediate) |
|---|---|---|---|---|---|
| `agent_tool_grant` | the agent's grant set (object id = agent id) | `agent_tools.manage` / `check.agents` | a draft agent's grants (its go-live shows them) | UPDATE = the widening grants only | removal; narrowing (off, confirm on, rules only added) |
| `escalation_rule` | one rule | `escalation.manage` / `check.agents` | created **off** | ACTIVATE (on, resume), UPDATE, DELETE | turning it off |
| `alert_rule` | business rule (same table) | `alert_rules.business.manage` / `check.agents` | created **off** | ACTIVATE, UPDATE, DELETE (deferred) | turning it off |
| `alert_rule_technical` | technical rule (same table) | `alert_rules.technical.manage` / `check.platform` | created **off** | ACTIVATE, UPDATE, DELETE (deferred) | turning it off |
| `message_template` | OCSO template record | CREATE `message_templates.manage`, DELETE `message_templates.delete` / `check.channels` | DRAFT in OCSO, never at the provider | CREATE (submit; deferred), DELETE (deferred at the provider; immediate for a draft) | — |
| `user` | the person | `users.manage` or `users.manage_team` / `check.permissions` | PENDING_APPROVAL | CREATE (activate in-tx; invite deferred), ACTIVATE (re-enable) | disable |
| `permission_change` | the person | `permissions.manage`, `users.manage`, `users.manage_team` or `teams.manage` / `check.permissions` | — | UPDATE = PERMS' `PermissionChangeSet` (the widening part) | every reduction |

- **Tool grants split.** `AgentToolGrantService.replace` computes the delta against the stored set (`grantDelta`, pure): removals and narrowing commit at once (audited `agent.tools_update`), whatever widens access is returned as `proposed` and the endpoint routes it through `requestApproval` (409 carries `details.applied`). A widening proposal's content hash covers the whole current set, so a removal made while it waits (allowed: a stop) voids it at decision (409 `content_changed`) until the maker refreshes it — the checker never approves a set they did not see. Validation re-checks that every proposed tool is still grantable.
- **Rules.** Escalation and alert rules are created off regardless of the input's `enabled`; `enabled` goes alone in a PUT/PATCH (400 `enabled_alone`). Hash bases leave out `enabled`, so a stop never voids a waiting change. An approved alert rule keeps its kind (400 `alert_rule_kind_fixed`): the kind decides who checks. An agent's rule takes the agent's configuration lock and waits while the agent's own proposal is open (`related`).
- **Templates.** Drafts are saved and edited in OCSO (`POST …/templates`, `PUT …/templates/drafts/:id`); submission (`POST …/drafts/:id/submit`, or `approval` on the create) and deletion are proposals. Deferred activation calls the provider only after the spine re-validated and re-checked both hashes; it is idempotent (a stored provider id is never created again; a retry looks the draft up at the provider by name and language before creating). A provider refusal (non-retriable DomainError) blocks the proposal and leaves the draft a draft.
- **Identity.** The API provides `IDENTITY_APPROVALS` = `createIdentityApprovals(ApprovalService)`; `onDirectRightsChange` refuses a draft edit of a pending user while its creation proposal is open (409 `approval_open`), voids a pending user's proposals when they are discarded, and lets every reduction through (a proposal it makes stale fails its content hash). Eligibility (`identityCheckerEligible`): never the target; shares a team with the target (or a team the change adds them to) or holds `users.manage`; when nobody but the maker and the target qualifies, any other holder of `approvals.check.permissions` (the platform-wide fallback, deviation 11). Bootstrap therefore only when nobody anywhere can check. `validate` re-runs PERMS' maker rules on the proposal's own change set (`revalidateMaker`), refuses a change that no longer widens access, and grants a preset may never hold.
- **Installed configuration.** The setup admin and the default alert rules are recorded as APPROVED `origin = 'MIGRATION'` proposals (`recordInstalledApproval`, `content_hash 'ap_installed'`), exactly like grandfathered configuration, so a fresh deployment has nothing live without an approval.
- **Migration 0027.** `message_templates.provider_template_id` nullable; `origin text NOT NULL DEFAULT 'OCSO' CHECK IN ('OCSO','PROVIDER')`; CHECK `provider_template_id IS NOT NULL OR (status = 'DRAFT' AND origin = 'OCSO')`. No other columns: approval state lives in `approval_proposals`.

**`liveObjects()` (what 0031 must cover, and what the exception report checks).**
- `agent_tool_grant`: LIVE/PAUSED agents with at least one grant and **no** APPROVED `agent` nor `agent_tool_grant` proposal — grants shown by an approved go-live (and every later widening, which is a proposal) are covered by the agent's approval. Empty once agents are grandfathered; 0031 needs no rows for this kind (inserting them for every agent with grants is harmless).
- `escalation_rule`: `enabled = true AND agent_id IS NOT NULL` (platform-wide rules are read-only in OCSO — assertMakeable refuses them — so they are governed outside it and not reported). Recommend grandfathering **every** existing agent rule (so a disabled one is "approved, off" and resuming it is ACTIVATE).
- `alert_rule` / `alert_rule_technical`: `enabled = true` of kind BUSINESS / TECHNICAL. Recommend grandfathering every existing rule, `object_kind` by its `kind`.
- `message_template`: `origin = 'OCSO' AND provider_template_id IS NOT NULL AND deleted_at IS NULL` (every pre-0027 row not deleted). **0031 must use this predicate, not 11b's `status = 'APPROVED' AND deleted_at IS NULL`**: the object is "a template OCSO put at the provider", whatever the provider's review says; with 11b's predicate PENDING/REJECTED/PAUSED templates would flood the exception report.
- `user`: `status = 'ACTIVE'`. Recommend grandfathering DISABLED users too (PERMS keeps approved users governed while disabled).
- `permission_change`: users holding an active GRANT whose `proposal_id` is not an APPROVED proposal — the grants table is new in this release, so a migrated v1 database has none; grandfather rows cannot link grants, so any such row stays reported (it is a real bypass). A direct GRANT that only shortens a live approved grant (a reduction) carries that grant's `proposal_id` (`applyPermissionChangeSet`), so narrowing never shows as a bypass.

**Deviations (smallest correct changes).**
1. *Spine hook `mayMake(principal, action)`* (contract, additive): one make permission cannot say who proposes identity changes (Tech: `users.manage`; Lead: `users.manage_team`). `canMake` replaces `can(makePermission)` at the four spine call sites; `makePermission` still names the canonical one for decorators and coverage.
2. *`user` CREATE activates inside the approval transaction and returns DEFERRED* for the invite — and is `settled` (deviation 7): the worker never re-validates or re-hashes it, so a reduction of the new user's rights, the maker losing rights or a failing mailer can never turn the approved, active user's proposal BLOCKED. A mailer that keeps failing stamps the proposal ACTIVATED with "the follow-up step failed: …" on the ACTIVATE decision.
3. *Alert rule DELETE is DEFERRED*: resolving the rule's alerts must notify destinations of plugin kinds and publish deliveries, which only the worker has (`business.alertRouting` / `alertQueue`); the API registry needs no deps. The approval transaction turns the rule off at once (audited `alert_rule.disable`), so it stops firing before the worker runs; `settled` = the row is gone.
4. *Template deletion of a provider-made template records it first* (`origin = 'PROVIDER'`), since a proposal needs an object id; those records never count as OCSO-approved content.
5. *Drafts save with problems* (400 only for a schema failure): `problems` are returned and refuse the submission (`validation_failed`), where the old single-step create answered 400.
6. *Escalation rule routes moved* from `prompts.controller.ts` into `escalation-rules.controller.ts` (same paths); `DELETE …/escalation-rules/:id` now answers 202/409 instead of 204.

7. *Spine hook `settled?(db, proposal)`* (contract + `deferred.ts`, additive). A DEFERRED kind says its approved change is already in effect — committed by `activate` (user CREATE) or by an earlier `activateDeferred` whose stamp was lost to a crash (alert rule gone; template carries its provider id or is marked deleted). The worker then skips re-validation and the hash checks, runs `activateDeferred` as an idempotent follow-up and stamps ACTIVATED; a terminal follow-up failure is recorded on the ACTIVATE decision, never BLOCKED. Rationale: "nothing a provider rejects shows as live" has a mirror — nothing live may carry a BLOCKED approval.
8. *`teamIds(tx, objectId, payload?)`* (contract + `proposals.ts` submit and edit, additive). A change that moves an object to another owner names both owners' teams: an alert-rule UPDATE to another agent (both agents' teams); an escalation rule (the agent's teams plus the teams serving its target queue, now and after). An edit recomputes teamIds and re-checks the named checker when they change. Validation of an alert-rule UPDATE that changes `agentId` re-runs `validateAlertRule` with the maker's principal, so the new agent must be in the maker's read scope (the draft path's rule).
9. *Identity bootstrap guard* (`identityBootstrapProblem`, in both identity descriptors' `validate`). A bootstrap self-approval of a `user` or `permission_change` is refused (`bootstrap_checker_disabled`) while another holder of `approvals.check.permissions` (not the maker, not the target) is DISABLED and was disabled within the last 30 days — disabling is a stop anyone with users.manage may do at once and must not manufacture "nobody else can check". The one exception is the way out: re-enabling a disabled holder of the check permission may be bootstrapped. After 30 days (a checker who really left) bootstrap is possible again; every bootstrap approval is already in the exception report (`bootstrapApprovals`). Check holders are now found in one SQL query (`holdsPermissionSql`) instead of one principal load per active user.
10. *Create-and-submit is all or nothing.* `POST` escalation rule / alert rule / channel template with `approval`: when the submission throws (no eligible checker, bootstrap refused, validation), the draft this request created is removed in a compensating transaction (`discardUnsubmittedDraft`, audited `<kind>.discard`, only while no proposal ever existed on it) and the error is returned — no duplicate draft on retry, no reserved template name.
11. *Template provider step.* Every attempt (not only retries) looks the draft up at the provider first; a listing failure is a retriable error (never answered with a create); a same-name template is adopted only when its customer-visible content (header, body, footer, buttons) equals the approved draft and no OCSO record holds its id — otherwise the proposal blocks with `template_name_taken`. No in-flight column was added (the lookup-first rule makes it unnecessary; 0027 unchanged).
12. *Tool-grant revocations* get their own audit rows (`agent_tool_grant.revoke` per removed tool, `agent_tool_grant.narrow` per narrowed one) besides the summary `agent.tools_update`. Escalation-rule `disable` audits the real previous state and writes nothing when the rule was already off. The user CREATE projection shows `onboarding: 'password set by the maker' | 'invite email'`.

**Rejected review findings (with reasons).**
- *Disabling a safety escalation rule / a default alert rule should need a checker.* The binding rule for every kind makes disable a stop: immediate, never locked. Changing that is a spec decision (11 §4), escalated, not taken here; it is audited and immediate today.
- *Hide identity proposal rows from Service members of the team.* Integrator decision: deviation 10 stays.
- *Let the maker discard a never-submitted template draft directly; edit a REJECTED template.* "DELETE always needs a proposal" is binding; the failed create-and-submit case is covered by item 10. Editing a REJECTED template as a new CREATE is a product change for a later wave.
- *Report provider-console templates that are sendable.* They are not OCSO objects (never approved or submitted by OCSO); whether they belong in the exception report is a spec question (11b), listed for the integrator.
- *Scope `targetQueueId` to the maker's queues.* Sending escalations to a specialist team's queue is a normal design; instead that team now owns the proposal too (item 8) and sees/checks it.

**Consequences.** On the e2e stack (`OCSO_DEV_SKIP_ACCESS_APPROVAL=true`) user creation and preset/team increases still apply directly; per-user grants, every rule, template and tool-grant flow go through checkers. Seeds and setups name a second Head: the demo seed turns escalation rules on and grants Maya's tools through approvals checked by the other Head.

### ADR-030 note — migration 0031 grandfathers live configuration (integrator)

`0031_approvals_grandfather.sql` records configuration that was live before maker–checker as approved: one
`origin = 'MIGRATION'`, `APPROVED` proposal (activated at once, no maker or checker, `content_hash 'ap_migration'`) per
live object, skipped when the object already has an APPROVED proposal. Each kind's set follows its descriptor's
`liveObjects()`, so `live_without_approval` (ADR-033) starts empty, widened to the supersets the owning areas asked for:
routers ACTIVE and DISABLED (ACTIVATE, so a disabled one can be resumed), every queue, every SLA policy, every agent
escalation rule (on or off), every alert rule (by kind), ACTIVE and DISABLED users, and every model profile (v1 had no
drafts). It inserts no rows for `permission_change` (grants are new in this release) or `agent_tool_grant` (covered by
the agent's approval). Nothing that runs today changes behaviour; the next change to any of these objects is a
proposal. Guard test: `packages/application/test/approvals/grandfather.int.test.ts`. The wave-1 drafts reserved 0027
for this migration; it landed as 0031, and the references in ADR-029–031 are updated accordingly.

## ADR-031 — Routers and queues as the service unit

**Status:** PROPOSED (2026-09-23) — design in `PM/research/11-governance-and-routing.md` §5 (owner decisions 8–10). Wave 1 builds the backend (data, engine, API, transfers, channels' CHOICES); wave 2 builds the router builder UI and registers the `router` / `queue` approval descriptors on top of the functions named below. Supersedes the ADR-026 addendum ("a channel answers as exactly one agent").

**Decision.** A customer reaches an agent through `channel → router → queue → agent`. The queue is the service unit: exactly one AI agent, its human teams, SLA, business hours, attributes and the queues it may transfer to. A channel names a router, never an agent.

- **Data (migrations 0024, 0025).** `routers` (name unique case-insensitively, `status` DRAFT|ACTIVE|DISABLED, `active_version_id`), `router_versions` (immutable: trigger `ocso_guard_router_version`, a router's own cascade excepted; `UNIQUE (router_id, version)`), `router_drafts` (the one editable copy). `channels.router_id` (ON DELETE SET NULL). `queues` gain `agent_id` (one agent per queue; ON DELETE SET NULL), `attributes jsonb` (unique when non-empty, values stored lower case), `business_hours jsonb NULL`, `transfer_target_ids uuid[]`. `conversations.agent_id` becomes nullable with `CHECK (agent_id IS NOT NULL OR control_state IN ('ROUTING', 'RESOLVED'))` (a conversation resolved before a router chose an agent keeps none; such a conversation is never reopened — the customer starts a new one); `control_state` gains `ROUTING`; the open-conversation unique index becomes `(customer_id, channel_id) WHERE control_state <> 'RESOLVED'`. `conversation_routing` (`router_version_id` → `router_versions` ON DELETE SET NULL) holds one row per routed conversation (phase RETURNING|STEPS|DONE, step index, attributes, answers, classifications, follow-ups, attempts, previous state, `awaiting_since`, `seq_from`, outcome RULE|MODEL|FALLBACK|PASS_THROUGH|CONTINUE|TIMEOUT|NEW, rule index, queue, decided at). `interactions.actor_type` gains `ROUTER`; `turns.agent_id` records who ran each turn. `channels.default_agent_id` and `agent_channels` stay (deprecated, unread, unwritten; dropped later).
- **Backfill (0025).** Each channel's agent is resolved once into a temp table (its default agent, else its `agent_channels` row — unique per channel since 0020). Every such agent, oldest first: its service queue is its default queue when no other agent serves it; else a new queue named after it (" (2)" on a clash). A queue created because the default queue was shared copies that queue's mode, auto-assign and accept timeouts, strategy, skills, languages, account-owner preference, SLA policy, after-hours message and hours, and is staffed by that queue's teams plus the agent's owning teams — so handoffs keep reaching the same people under the same SLA (asserted by `routing-backfill.int.test.ts`); an agent with no default queue gets one staffed by its owning teams (before, its handoffs had no queue at all). Each such channel gets an ACTIVE pass-through router named after it (version 1 + draft) — the live demo "WhatsApp — Twilio" → router "WhatsApp — Twilio" → queue "Maya", no behaviour change. Every conversation without a queue (open or resolved) joins its agent's service queue, so a reopen lands in a queue. Duplicate open conversations per (customer, channel) keep the one a person is working (HUMAN_ACTIVE, AI_RESUMING, WAITING_FOR_HUMAN, ESCALATION_REQUESTED, then the rest; newest within each); the others → RESOLVED `SUPERSEDED_BY_ROUTING_MIGRATION` with a `system.control_changed` timeline entry naming the kept conversation, open handoffs cancelled, assignments ended. One `audit_events` row (`routing.backfill`, actor SYSTEM `migration:0025_routing_backfill`) lists the routers, service queues and superseded conversations (none on a fresh database). Then the index swap; turns get their conversation's agent. The migration-created routers and queues still need `MIGRATION` approval rows from 0031 (grandfather, wave 2) — a release blocker for the integrator.
- **Definition (`@ocso/domain` `RouterDefinitionSchema`, browser-safe).** Steps (≤ 10) `ASK` (2–10 options, synonyms, `maxAttempts`, `skipIfKnown`), `CLASSIFY` (model profile, labels, `minConfidence`, `maxFollowUps`), `KNOWN` (`customer.language` or `customer.attribute:<key>`); rules (≤ 100, first match, every key must match, arrays match any value, empty `when` matches all); a required fallback queue; optional `returning { askAfter {value, HOURS|DAYS|MONTHS}, prompt, continueLabel, newLabel }`; `timeoutMinutes`. Structural checks (unique step ids, option values and labels, continue ≠ new) are part of the schema; references (queues exist and have an agent, profiles exist, per-channel templates belong to their channel and are approved) are checked at activation.
- **The engine is a pure state machine.** `advanceSession(definition, session, event, ctx)` (`@ocso/domain`) takes START / REPLY / CLASSIFIED / TIMEOUT and returns the new session plus actions SEND / CLASSIFY / DECIDE / CONTINUE / NEW. The worker engine (`RoutingEngine`, application) and the simulator (`simulateRouter`) run the same function, so the simulate panel shows exactly what production does. Matching (`matchOption`) takes a tapped option id first, then the number, value, label or a synonym (case-insensitive), then a reply mentioning exactly one option.
- **Ingress.** `admitConversation` replaces agent resolution. Conversations under way never depend on the channel's router: the customer's open conversation (any state, including a menu running on its pinned version) or one resolved within the reopen window (with an agent) takes the message whatever the router's state; the returning question needs the channel's ACTIVE router. Only a new conversation needs an ACTIVE router: without one it is rejected `no_router` — logged at error (`onRejected`) and recorded as an `audit_events` row `conversation.inbound_rejected` (channel, customer id, external message id, reason; not the text: audit readers are not conversation readers). An AI_ACTIVE conversation after the returning gap goes `ROUTE_START` → ROUTING/RETURNING; a resolved one reopens silently (into a queue its agent serves when it predates routing and has none), or into RETURNING after the gap; otherwise a new conversation — pass-through routers decide synchronously, exactly the old path (AI_ACTIVE with queue and agent, a `conversation_routing` row with outcome PASS_THROUGH, and `conversation.routed` with the router version); routers with steps open it in ROUTING with no agent.
- **`conversation.route`.** `RouteProcessor` (agent-runtime) runs `RoutingEngine.advance`: each step is one transaction that locks the conversation and its routing row, feeds the customer's new messages (seq > `last_processed_seq`, which the router uses as its read pointer while ROUTING) as replies — stopping once a new question went out, since later messages were written before the customer saw it — writes router messages, and persists (`awaiting_since` restarts with every question, so the timeout measures silence since the last question); a CLASSIFY step commits, calls the model outside any transaction (`createRouterClassifier`: the step's profile through the model gateway, structured output `{label, confidence, followUp}`, usage purpose CLASSIFIER), and applies the result only if the session did not move meanwhile. `ROUTE_COMPLETE` sets queue, agent, the agent's conversation type and the queue's resolution deadline, resets `last_processed_seq` to `seq_from` so the agent answers everything the customer wrote since routing started, writes a `system.routed` timeline event ("Routed to Sales — rule 1: product=sales") and `conversation.routed`, and publishes `conversation.turn`. `ROUTE_CONTINUE` restores the previous state (a resolved conversation reopens to the AI — only then does it count as a reopen: `ROUTE_START` from RESOLVED leaves `resolved_at` and `reopen_count` alone) and emits `conversation.routed` (CONTINUE/TIMEOUT). "New" resolves the old conversation (`CUSTOMER_STARTED_NEW`; one that was already resolved stays exactly as it was, with no second `conversation.resolved`) and opens a new one in ROUTING with copies of the messages that brought the customer back (idempotency `…:carried`), routed at once. A model failure or unusable answer is "unclassified" (the step is left unset), never a stall; a failure is recorded on the session (`classifications[step].error`) so an outage is told apart from low confidence. **Choosing the queue:** the decided queue if its agent answers (LIVE with a model profile), else the fallback if its agent answers, else whichever of the two has an agent — routed there and handed to a person at once (`requestHandoff`, reason `agent_unavailable`), never left AI_ACTIVE with an agent that will not reply. When neither queue has any agent the decision is not applied: the session is saved as "deciding" (phase STEPS, past the last step, not DONE), the conversation stays ROUTING (visible to the Leads the router reaches) with one `system.routing_blocked` timeline entry, and every new customer message and every sweep retries until a queue has an agent. Leader task `routing-timeout` (60 s): the due check runs in SQL against each session's pinned version (`awaiting_since < now − timeoutMinutes`), so long-timeout routers cannot crowd short ones out of the batch (the result reports `overdue` when a batch is full); inside the transaction an answer already stored wins over the timeout; the returning question → continue. Routing that stalled is re-signalled: a session not waiting, one with an unprocessed *customer* message (not the router's own question), or a DONE row still in ROUTING (rows from before this fix).
- **Router messages** are OUTBOUND interactions with actor ROUTER, delivered by `channel.deliver`. A question is a CHOICES part (below); outside the channel's session window the router's per-channel approved template (no variables) is sent instead when mapped. The compiled prompt shows them as assistant turns marked "(automated menu)"; the widget shows them as the assistant without a name.
- **CHOICES (channels boundary).** `ChannelCapabilities.choices?: {buttons, list}`; the part is `STRUCTURED` `schema: 'ocso.choices'`, `data: {text, options: [{id, label}]}`, numbered `fallbackText` (`choicesPart`, `choicesOf`, `renderChoicesAsText`, `choicesPresentation`). WhatsApp (Meta): ≤ 3 reply buttons, ≤ 10 list rows (text when cut titles collide); Twilio: numbered text; web chat: widget buttons. Taps come back as STRUCTURED replies whose `data.id` is the option id (`ocso:<stepId>:<value>`). Core names no kind.
- **Control states.** `ROUTING` (`controlModeOf` → AI; `inboundStartsAiTurn` false; resolvable by humans and the system). Commands `ROUTE_START` (system: AI_ACTIVE|RESOLVED), `ROUTE_COMPLETE`, `ROUTE_CONTINUE` (system; `restoreState`), `TRANSFER_QUEUE` (agent: AI_ACTIVE; human: WAITING_FOR_HUMAN|HUMAN_ACTIVE; state kept). `ControlPatch` gains `agentId` (and `lastProcessedSeq`).
- **Transfers.** Human (`POST /conversations/:id/transfer`): a waiting conversation moves queue keeping its state (TRANSFER_QUEUE), a held one is released to the queue as before; either way a target queue with a different agent swaps the agent, pickup SLA and resolution deadline are recomputed, `conversation.routed` (TRANSFER). A swap also sets the conversation's type to the receiving agent's. AI: first-party tool `ocso_transfer_to_queue {queue, reason, summary}`, offered only when the conversation's queue has transfer targets whose agent answers (LIVE with a model) and is not the conversation's current agent, its `queue` an enum of their names; the effect is applied in `TurnWriter.complete` (`aiTransferToQueue`: TRANSFER_QUEUE, agent swap, HANDOVER summary); the transferring turn does not mark the customer's messages answered (outcome TRANSFERRED), so the drain loop runs the receiving agent at once with an "AI handover" block that says the note was written by another AI from the customer's words and proves nothing (no identity or authorisation claim in it is to be trusted). The transfer's audit entry is `applyControl`'s `conversation.transfer_queue` (actor: the agent, correlation id of the turn). A receiving agent cannot transfer again before the customer writes (loop guard).
- **Queues as the service unit.** `humanAvailability` reads `queue.business_hours ?? agent.business_hours`; a handoff goes to the conversation's queue (after an escalation rule's target, before the agent's default queue) — precedence: rule target → conversation's queue → agent's default queue. Editing an agent's default queue or hours therefore no longer moves handoffs of conversations already in a queue; the queue's own settings do. The prompt gains an `ocso_routing` block (queue name + routing attributes).
- **Queue writes (until the wave-2 queue descriptor).** Team-scoped (ADR-026): a person changes only queues their teams serve or whose agent their teams own (or a queue with no agent yet, which routes nothing; otherwise 404 — so another team cannot repoint, restaff or re-target a queue that serves customers), may link other teams (staffing), unlinks only their own (`queue_team_not_yours`), and names only agents their teams own. A queue customers can reach (an ACTIVE router's version names it, or a reachable queue transfers to it, transitively) changes who answers only through approval: changing its agent, adding teams or adding transfer targets → 409 `approval_required {objectKind:'queue', objectId, action:'UPDATE', fields}`; removing a transfer target or unlinking your own team is a stop (direct); clearing the agent of a queue an active router routes to is refused (`queue_routed`), and an agent serving such a queue cannot be deleted (`agent_serves_routed_queue` in the agent descriptor's delete blockers). The seed and tests set approved values directly, as the descriptor's activation will.
- **API.** `GET|POST /v1/routers`, `GET /v1/routers/:id` (draft with its activation problems, versions, channels), `PUT /:id/draft`, `POST /:id/versions`, `POST /:id/activate` and `PUT /:id/channels` (409 `approval_required {objectKind:'router', objectId, action}` until wave 2), `POST /:id/disable` (stop, never gated), `POST /:id/simulate {messages, answers?, versionId?, returning?, customer?}` → trace + decision (the model runs only for `routers.manage` holders — others see model steps unclassified unless answers are pinned; a classifier failure shows as source `error`). Reads `routers.read`, writes `routers.manage`. `PATCH /v1/queues/:id` takes `agentId, attributes, businessHours, transferTargetIds`. Conversation detail gains `routing`; `agent` is null while ROUTING (inbox and detail). Channel views gain `router`; `defaultAgentId` is now derived (the agent of a pass-through router) and no longer accepted. Agents' `channelIds` are derived ("reached through": channels whose active router can route to a queue the agent serves); setting them is refused (`channels_route_through_routers`).
- **For wave 2.** `RouterService.activateVersion(tx, actor, versionId)` / `activateRouterVersion` and `RouterService.attachChannels(tx, actor, routerId, channelIds)` / `attachRouterChannels` are the descriptor's `activate`; `routerActivationProblems(tx, definition)` its `validate`; `disableRouter` the stop action. `createActiveRouter` / `createPassThroughRouter` / `routeChannelToAgent` are the trusted seed and test path (no permission, no approval) — no public bypass exists.

**Why.** One agent per channel could not serve a bank's reality — languages, products, returning customers — and the two records of that one fact (`default_agent_id`, `agent_channels`) already drifted. Making the queue the unit ties the AI agent to the same place as its humans, hours, SLA and attributes, so escalation, availability and transfers read one object. A pure state machine keeps the engine testable and the simulator honest; locking per step with an optimistic check around the model call keeps the worker crash-safe without holding a transaction across a provider call.

**Alternatives.** Routing rules on the channel (no reuse across channels, no drafts or versions); running routing as an agent with tools (non-deterministic, costly, and a model would decide who answers); keeping `default_agent_id` as a cache (the drift problem again); a separate `conversation_routing` history table (the timeline events and the audit already give history).

**Deviations from the spec (smallest correct changes).**
1. The CHOICES part is a `STRUCTURED` part with `schema: 'ocso.choices'`, not a new `InteractionPart` type: every renderer, transcript, preview and model view already handles STRUCTURED with a `fallbackText`, so channels without native choices still send an answerable numbered question, and nothing else in core or the web had to change.
2. Inbound taps stay STRUCTURED (`button_reply` / `list_reply`) with the option label as `fallbackText` instead of being rewritten to TEXT: the matcher reads the option id first (exact even when WhatsApp cut the title to 20 characters) and the text second. The web chat widget sends a tap as the label text.
3. `conversation_routing.seq_from` (not in §5.1): where the agent's unanswered messages begin, so the chosen agent answers the customer's opening message rather than only the menu answer; `outcome` also takes `NEW` for the conversation the customer left.
4. The route consumer does not take the turn lease: a lease acquired on the same worker would fence an AI turn in flight. Each engine step locks the conversation and routing rows, and a model result is applied only if the routing row is unchanged, which gives the same exclusion for ROUTING conversations.
5. `TRANSFER_QUEUE` by a human from HUMAN_ACTIVE keeps today's behaviour (released to the target queue, WAITING_FOR_HUMAN); from WAITING_FOR_HUMAN it keeps the state. A conversation cannot be held by a human without an assignee, so "keep state" from HUMAN_ACTIVE would be invalid.
6. The AI transfer tool's enum holds queue names (unique case-insensitively) rather than ids — what a model can choose reliably; the handler re-resolves and re-validates against the live transfer targets.
7. Leads (`conversations.read_team`) also see ROUTING conversations the router itself opened (no agent yet, phase STEPS, `seq_from = 0`) whose router can route to a queue their teams serve or an agent they own (no agent or queue exists yet to scope by). A returning customer's conversation (it has an agent, queue and history) stays visible only to its own agent's and queue's teams while they are asked. Service members see them once routed.
8. Human handoffs go to the conversation's queue before the agent's default queue (an escalation rule's target still wins): with routing the conversation's queue is the service unit. The backfill keeps destinations equal (a queue made because of a shared default queue copies its staff, SLA and settings).
9. Routing hands a customer to a person when no candidate queue's agent answers, and holds the decision (retrying) when no candidate queue has an agent at all — the spec leaves both cases open.
10. Until wave 2, disabling a router cannot be undone over HTTP (resuming is an ACTIVATE and needs approval, §2 decision 4). Its effect is limited to new conversations; customers already in a conversation are unaffected.

**Consequences.** Every channel needs an active router to take messages; the migration gives each existing one a pass-through router. New conversations may exist without an agent (ROUTING): analytics, insights, summaries, CSAT and reviews skip or refuse them until routed. A conversation's agent can change (transfers), so turns, timeline messages and web chat messages carry their own agent. Router activation and channel attachment are approvals (wave 2); until then only seeds, tests and migration create live routers. The web keeps working with nullable agents (shown as "Router" until the wave-2 routing card) and renders ROUTER timeline messages; the agent Channels tab's editor now gets 400 until wave 2 turns it into "Reached through". Not done in wave 1: activation does not yet check that referenced queues and model profiles are *approved* (the descriptors are wave 2), and the classifier runs any existing profile; classifier errors are recorded per session and logged, with no error-rate alert yet; the route consumer is serialised per conversation by the queue's group key and by row locks, not the turn lease (deviation 4) — a sweep `expire` racing a consumer can at worst repeat one model call. Known limits: the WhatsApp list button reads "Choose"; router messages are single-language text (templates per channel only for outside the window); the returning check applies to AI_ACTIVE and recently resolved conversations, not to ones a human holds.

**Spec impact.** docs/07 (implementation notes: routing, CHOICES), docs/plugins/channels.md (routing, choices capability, limits). docs/01/03/09/14 and README are merged by the integrator.

### ADR-031 amendment A (2026-09-23) — routing under maker–checker, and the routing UI (wave 2, ROUTING-WEB)

**Status:** PROPOSED (2026-09-23; revised after adversarial review the same day). Amends ADR-031 ("For wave 2", deviation 10, "Queue writes (until the wave-2 queue descriptor)") and builds on ADR-030 (the approval spine). Design: PM/research/11 §4, §5.7.

**Decision.** Routers, queues and SLA policies are approval kinds registered in `approvals/composition.ts`, all checked with `approvals.check.routing` (Heads).

- **`router`** (`routing/router-approval.ts`) — actions ACTIVATE, UPDATE, DELETE; make permission `routers.manage`.
  - A router is created as a DRAFT; its draft definition is always edited directly (inert); **Save as new version** freezes it (immutable, inert).
  - **ACTIVATE** takes the router's *newest* version live — first activation, a new version, or resuming a DISABLED router (§2 decision 4). Always a proposal. `POST /v1/routers/:id/activate {versionId, approval}` refuses any other version (409 `version_not_latest`; restore the older one as the draft and freeze it again).
  - **UPDATE** = rename/describe (`PATCH /v1/routers/:id`) and attaching channels (`PUT /:id/channels`). On a router never approved and never live these apply directly; afterwards they are proposals. The payload is a delta (`attachChannelIds`).
  - **Stops (immediate, never locked by an open proposal):** disabling; detaching channels — the channels left out of the `PUT` set are detached before anything else is considered.
  - **DELETE** is always a proposal, refused while channels are attached, while conversations are being routed by it, and once it has routed anyone (`router_has_history`): its versions are those customers' routing record (`conversation_routing.router_version_id` is `ON DELETE SET NULL`). Such a router is disabled, never deleted.
  - **A stop is never undone by approving an older proposal:** an ACTIVATE whose before-snapshot was not DISABLED is blocked (`router_disabled_since`) if the router has been disabled since. Resuming is its own proposal (titled "Resume router …").
  - **Owner scope (makers and checkers):** a router that has ever gone live belongs to the teams its *active* version serves (the teams of its queues and of their agents; `router-scope.ts`). Only principals in one of those teams may edit its draft, freeze, rename, attach, detach, disable, or propose (`assertMakeable`). Its proposals' checker teams are the same set. A router that never went live is open to any `routers.manage` holder, and its first version's teams check it. The projection carries `servedTeams`, so a version that moves traffic between teams shows it in the diff.
  - **Channels are never taken from another router:** attaching a channel another router routes is refused, both directly (409 `channel_on_other_router`) and in UPDATE validation. The channel is first detached on its router, by that router's teams (a stop, audited there). When the attach part of `PUT /:id/channels` is refused, the error's `details.detached` names the channels already detached.
  - **Validation** (at submit, render and again inside the approval transaction): every queue the version routes to (rules + fallback) is approved and has a LIVE agent; every CLASSIFY model profile is approved (`model_profile` kind); per-channel templates belong to their channel and are approved (core check). A reference whose own approval is open (queue CREATE, agent go-live, profile approval) is a *soft* problem: the maker may submit, the checker sees it as a `validation_failed` warning, and approving blocks until it lands. Anything else refuses the submit.
  - **Content hash** covers `{name, description, latestVersionId, activeVersionId}` — freezing another version voids an open ACTIVATE (the checker approves exactly the version they saw). Status and attached channels are left out, because disable and detach are stops.
  - **Dependencies:** `queue:<id>@updated_at` and `model_profile:<id>@updated_at` of the version's references.
  - **Checker teams:** see owner scope above; none → platform-wide.
  - **Visibility:** `routers.read`.
- **`queue`** (`routing/queue-approval.ts`, `queue-writes.ts`) — actions CREATE, UPDATE; make permission `queues.manage`.
  - A queue is created as a draft (`POST /v1/queues`, direct).
  - **CREATE** is its first approval, approving it as it is: `POST /v1/queues/:id/submit {approval}`, or `approval` on the create call; the payload must be empty. Only approved queues can be routed to.
  - **UPDATE:** once approved — or while the queue is live (`LIVE_QUEUE_IDS`, the same definition the exception report uses) — every change is a proposal. This covers agent, attributes, hours, SLA policy, pickup settings, name, added teams and added transfer targets. The payload is a delta (`addTeamIds`, `addTransferTargetIds`), so a stop taken while it is open is never undone by approving it.
  - **Stops, justified one by one:**
    - Unlinking one of your own teams is a rights reduction: that team stops seeing and claiming the queue's conversations, the same class as leaving a team.
    - Removing a transfer target only narrows where the AI or a person may move conversations.
    - Clearing the agent is **not** a stop: it changes who answers, and it is refused (`queue_routed`) while an active router routes to the queue — pausing the agent is the stop.
  - Unlinking the **last** team of a live queue is refused (`queue_last_team`): it would strand the queue's handoffs, which degrades live service rather than stopping it.
  - `PATCH /v1/queues/:id` applies the stops first. It then applies the rest directly on a draft, or answers 202 with `approval`, or 409 `approval_required` with `details.applied` naming the stops already applied.
  - **`baseline`** (optional on the PATCH): the team and transfer-target lists the editor loaded. With it, the full lists are read as edits of that baseline, so only ids the editor saw and unticked are removed, and a stale dialog never undoes an addition (or an approved change) made since. The web queue dialog always sends it; without it, the lists replace the current ones (API clients).
  - **Validation:**
    - name and attribute uniqueness;
    - the new agent must be owned by one of the maker's teams, re-checked against the maker's current teams even through `POST /v1/approvals`; on a live queue it must be LIVE (soft while its go-live is pending), so live routing never lands on an agent that does not answer;
    - added teams must exist;
    - added transfer targets must exist, must not be the queue itself, and must be approved. A target whose own CREATE is open is accepted at submit *and* at activation, and is marked "(awaiting approval)" in the checker's projection. Otherwise two queues that transfer to each other could never be approved. This is safe because approval is enforced **at use**: the AI transfer tool (`aiTransferTargets`) offers only approved targets, and a human transfer into a queue that is not approved is refused (409 `queue_not_approved`, except the conversation's own queue). A human transfer also never swaps in an agent that is not LIVE; the conversation keeps its agent. The web transfer dialog lists approved queues only.
    - the SLA policy must be approved (soft while it is pending).
  - **Content hash:** the row's ids and values without teams and transfer targets, because their removals are stops.
  - **Dependencies:** the SLA policy's `updated_at`.
  - **Checker teams:** the queue's teams ∪ its agent's owning teams.
  - **Visibility:** any `queues.read` holder, because the queue list is not team-scoped. Write scope is `assertQueueInScope`.
  - CREATE approval never touches the row. Stops do not bump `updated_at`: it is the dependency stamp of router proposals, so neither voids them.
- **`sla_policy`** (`routing/sla-approval.ts`) — actions CREATE, UPDATE; make permission `sla.manage`. It is a draft until CREATE. UPDATE carries the whole policy and is required once the policy is approved or a live queue uses it. There is no stop. Checker teams are the teams of the queues using it; none → platform-wide.
- **Live objects** (the exception report's `live_without_approval`, and the integrator's 0031 guard):
  - `router`: `status = 'ACTIVE'` (a disabled router routes nothing).
  - `queue` (`LIVE_QUEUE_IDS`, recursive): queues an ACTIVE router's active version routes to (fallback and rules), plus default queues of LIVE/PAUSED agents, plus target queues of enabled escalation rules (global, or of LIVE/PAUSED agents), plus transitively their transfer targets.
  - `sla_policy`: the policies of live queues.
  - **0031 must grandfather** every router with status ACTIVE or DISABLED (ACTIVATE, so a disabled one can be resumed), every queue (CREATE) and every SLA policy (CREATE). That is a superset of the live objects, so it is safe. Without it, after an upgrade: every live queue and router is reported live-without-approval; a resume or new version of a 0025 pass-through router fails validation with `queue_not_approved`; human transfers into existing queues are refused; and the AI transfer tool offers no targets. This is a **release blocker**, owned by the integrator (0031 is reserved for them).
- **Wave-1 stubs replaced:** `RouterService.requestActivation/requestChannels`, `routerApprovalRequired`, `queueApprovalRequired`, and `assertLiveQueueChange` are gone. The trusted seed/test path (`createActiveRouter`, `routeChannelToAgent`, `activateRouterVersion`) keeps the core checks only.
- **Migration 0030** adds indexes only: `channels_router_idx` and `conversation_routing_router_idx`. The schema TS is updated to match. Approval state is derived (ADR-030).
- **API additions:**
  - `PATCH /v1/routers/:id`, `DELETE /v1/routers/:id`
  - `GET /v1/routers/reach?agentId=` — "Reached through": channel → router → queue (routers.read plus read access to the agent)
  - `GET /v1/routers/:id` gains `approval` and `latestVersionId`
  - `POST /v1/queues/:id/submit`, `GET /v1/queues/:id/approval`
  - `POST /v1/sla-policies/:id/submit`, `GET /v1/sla-policies/:id/approval`
  - The queue and SLA lists carry `approval {approved, pending}`
  - The conversation detail's `routing` gains `rule` (the deciding rule in words) and `routerVersion`
  - The inbox gains the `routing` view and count
- **Web:**
  - `/routers` list and `/routers/[id]` builder: ASK / CLASSIFY / KNOWN steps; rules over attributes, typed as `a=b, c=d|e`, with **Rules from queue attributes**; fallback queue; returning customers (value + hours/days/months); timeout. Each message has a one-click **Create template for <channel>**, which drafts the template and opens its `message_template` CREATE approval through the generic `POST /v1/approvals`. The page also has a simulate panel with the decision trace, the versions panel with **Activate vN** / **Resume with vN** through approval, and the channels panel.
  - The queue dialog gains the agent, attributes (key/value), human hours and transfer targets, and becomes a submit-for-approval flow once the queue is approved. Queue and SLA rows show draft / pending / approved state with **Submit**.
  - Workspace: the **Routing** card, the **Routing** control-state chip (new kind `routing`), and the **Routing** inbox filter. The transfer dialog names the receiving agent.
  - The agent Channels tab becomes the derived **Reached through** list; the channel screen shows its router.
  - The nav gets a **Routers** item: Operations for `routers.read` holders (Lead, Head), Oversight for Tech.
- **Seeds and harnesses go through approvals:**
  - The demo seed (`approveRouting`): each demo Head checks the other's SLA policies and queue CREATEs, all submitted before any is decided. The web chat router is created as a draft attached to the channel and activated through approval after Maya is live.
  - The chaos harness (`tests/resilience/lib/client.mjs`) no longer uses SQL. It uses the queue submit and router activation (bootstrap: the lead is the only routing checker), and the channel, provider, profile and worker settings go through their own approvals, with the Head as checker.

**Why.** Routing decides who answers a customer, so it is exactly the configuration maker–checker exists for. Deltas for list fields and hash bases that ignore stop-able state keep ADR-030's rule — stops are never blocked or undone by an open proposal — without voiding proposals on every stop. Pinning the newest version through the hash (not the payload) keeps the spine unchanged: its `parsePayload` drops ACTIVATE payloads.

**Deviations from the spec (smallest correct changes).**
1. ACTIVATE activates the router's newest version (pinned by the content hash) rather than carrying `versionId` in its payload: the spine keeps payloads only for CREATE/UPDATE. Rolling back = restore as draft + freeze + activate.
2. Attaching a channel to a router that was never approved nor live is direct: it makes nothing live, because the router routes nothing until its ACTIVATE is approved, and the checker then sees the channels. Only unrouted channels can be attached. Moving a channel away from another router is that router's stop, taken by that router's teams.
3. UPDATE proposals are deltas (`attachChannelIds`; `addTeamIds`/`addTransferTargetIds`), not the PATCH body; removals never enter a proposal.
4. `requiresApproval` for UPDATE also covers configuration that is live without an approval yet (a router not DRAFT; a queue in `LIVE_QUEUE_IDS`; an SLA policy of a live queue), so data from before approvals (until 0031) and trusted-path seeds cannot change unreviewed.
5. A transfer target awaiting its own CREATE does not block (see above); other pending references do block at activation.
6. Queues are visible to every `queues.read` holder (their list always was); the wave-1 team scope remains the *write* scope.
7. The queue dialog's "Routing mode" is renamed "Pickup mode" (routers now route); `e2e/ops.spec.ts` is updated.
8. Checker eligibility stays any-of over the proposal's teams (ADR-030). For a router shared by teams A and B, a Head of A can still approve a version that moves B's traffic. The `servedTeams` diff makes that visible, but an all-of rule would need a spine change and is left for later.
9. Disable and detach are stops, but only for the router's own teams (owner scope). A Lead cannot stop another team's channel.

**Consequences.**
- A Lead needs a Head for every routing change that makes something live or changes a live object; a deployment with a single Head bootstraps (recorded in the exception report), and a router a Lead disabled stays off until that Head resumes it. Tech does not hold `approvals.check.routing`. The setup guide (§5a) recommends at least two routing checkers.
- Model-profile approval is required for CLASSIFY routers once the `model_profile` kind exists (COVERAGE-PLATFORM).
- Approving a router before its queues blocks it (the maker resubmits); the approvals queue lists queues and routers separately.
- Not done: a UI rename for approved routers (the API supports it); "restore as draft" for versions other than the live one (the detail API does not return old definitions).

## ADR-032 — The audit store: audit events in their own append-only database, sealed and signed

**Status:** PROPOSED (2026-09-23) — product owner decision 11 in PM/research/11 §2 ("Audit store is a driver plugin in its own database (postgres now + clickhouse built), chosen at bootstrap; the main DB keeps the same-transaction write (outbox). Auditor grade."). Design: PM/research/11 §6. Builds on ADR-004 (migrations), ADR-009 (outbox pattern), ADR-011 (BlobStore), ADR-026 (team scope), ADR-028 (drivers are registries).

**Decision.**

1. **The main database keeps writing, the store is the system of record.** `recordAudit` is unchanged for callers: it writes `audit_events` in the same transaction as the change. `audit_events` is now the *transactional outbox* of the audit store and the recent local window. Migration `0026_audit_outbox` adds `team_ids uuid[]` (the read scope), `shipped_at`, `verified_at` (partial indexes on unshipped / unverified), `audit_incidents`, `audit_exports`, and `audit_verifications` (full-chain verification runs) and `deployment_settings.audit_local_window_days` (default 90, CHECK 90..3650 — 90 is the widest analytics window reading local rows). The immutability trigger function is replaced: it permits exactly (a) an UPDATE that changes nothing but `shipped_at`/`verified_at` and never leaves a row verified without having been shipped, (b) a DELETE under the retention cutoff the transaction declares (≥ 365 days, as since 0010), (c) a DELETE of a *verified* row older than 90 days when the transaction sets `ocso.audit_local_prune = 'on'`. TRUNCATE is always refused. Existing rows are backfilled with `team_ids` = the target's teams ∪ an AGENT actor's teams (not a user actor's *current* teams, which may not be the teams they acted for); ids are cast once behind a uuid check so every lookup uses an index. They ship as history.
2. **A new package, `@ocso/audit-store`**, owns the contract (`AuditStore`, `AuditRecord`, `AuditScopeFilter`, `ChainEntry`, `Checkpoint`), canonical hashing, Ed25519 signing, chain sealing and verification, both drivers, their migrations and two bins. It depends on `pg` and `@ocso/config` only (not on `@ocso/db`), so `@ocso/db/testing` can provision a throwaway audit database for every test harness.
3. **Drivers are a registered kind** (ADR-028): `OcsoPlugin.auditStoreDrivers`, `DriverRegistries.audit`, selected by `AUDIT_DRIVER` (default `postgres`), checked by `assertDrivers` / `assertWorkerDrivers` (which also require the signing key in production), built by `createAuditStore`. `FIRST_PARTY_PLUGINS` gains `{ name: '@ocso/audit-store', auditStoreDrivers: [postgres, clickhouse] }`. A driver definition also carries `provision(env)` for the `audit-migrate` bin.
   - **postgres**: its own database (`AUDIT_DATABASE_URL`: the writer for the worker, the reader for the api). `audit_records` range-partitioned by UTC month (PK `(id, occurred_at)`, `team_ids` GIN, an `ingest_seq` arrival order), `audit_chain` (position PK, `record_id` unique, CHECKed 64-hex hashes), `audit_checkpoints` (FK to the chain). UPDATE/DELETE/TRUNCATE are rejected by triggers for every role, the owner included (partitions get a TRUNCATE trigger as they are created). The writer role has INSERT/SELECT on the three tables, USAGE on the ingest sequence and EXECUTE on two `SECURITY DEFINER` functions: `audit_ensure_partitions(months_ahead, from_ts)` and `audit_purge_before(cutoff)` (drops whole months ending before `LEAST(cutoff, now() − min_retention_days)`, the floor read from the owner-only `audit_store_config` (≥ 365, `AUDIT_MIN_RETENTION_DAYS`), and logs each drop in the append-only `audit_purges`). The optional **reader role** (`AUDIT_READER_URL`, the api) has SELECT on the data tables and `audit_purges` only. Every pool has a connect timeout, a client-side query timeout and a server `statement_timeout` (`AUDIT_STORE_TIMEOUT_MS`, default 15 s).
   - **clickhouse**: the HTTP interface over the injected fetch (no SDK), typed query parameters, JSONEachRow, a 10 s request timeout (5 s for health). `audit_records` a plain MergeTree partitioned `toYYYYMM(occurred_at)` ordered `(occurred_at, id)`, read **first copy wins** (`LIMIT 1 BY id`, earliest ingest) — a ReplacingMergeTree would let a later INSERT replace a record at merge; `audit_chain` and `audit_checkpoints` MergeTree; `audit_purges` and `audit_store_config`. The writer user has SELECT and INSERT only; the optional reader user SELECT only. The chain insert's deduplication token is the first position alone, and `appendChain` reads the position back and throws if another sealer won, so overlapping sealers cannot fork. ClickHouse is **tamper-evident, not append-only**: `chainRange` reports a second chain row at a position (`forks`) and a second stored copy of a record with other content (`conflicts`), which verification turns into `CHAIN_FORK` / `RECORD_CONFLICT`. The minimum retention is enforced by the driver.
4. **Worker leader tasks** (apps/worker/src/audit; each with a 60 s deadline; while the shipper backs off from a failing store the others skip their store work, so a store that hangs never stalls the rest of the sequential leader tick): `audit-ship` (2 s: 500 oldest unshipped rows per round → idempotent `append` → `shipped_at`; failure → `SHIP_FAILED` or `STORE_DOWN` incident, exponential backoff 2 s…60 s, OCSO keeps serving; any successful round resolves both incidents, whichever worker or process opened them), `audit-reconcile` (5 min: shipped-unverified rows older than 30 s → `has()` → `verified_at`, or `shipped_at` cleared and a `RECONCILE_MISSING` incident), `audit-seal` (10 s, fenced by `pg_try_advisory_xact_lock` in the main database: `unsealed()` in arrival order → chain entries from the head → `appendChain`; every 1 000 entries or hourly re-verify only what is new since the last checkpoint — or since the last check of an open break — at most 50 000 entries per run, and sign a checkpoint at the verified end; new problems open or widen `CHAIN_BROKEN` (detail: `firstBrokenAt`, `lastBrokenAt`, `checkedTo`, problems) and sign nothing, while later ranges that verify on their own are still signed; a last checkpoint by an untrusted key opens `SIGNING_KEY_CHANGED`), `audit-verify-full` (every minute until done, one pass a day: the whole chain in 50 000-entry pages, resuming from `audit_verifications.checked_to`; problems outside acknowledged breaks open `CHAIN_BROKEN`), `audit-export` (checked hourly, at most daily: the sealed range up to a checkpoint → `audit-exports/YYYY/MM/DD/<from>-<to>.ndjson.gz` + a signed `.manifest.json` with the checkpoint, the public key and the file's sha256, via the BlobStore; `EXPORT_FAILED` on error, or when no newer checkpoint by this key allows an export for two periods). Retention prunes the local window (verified rows only, after asking the store again: rows it no longer holds — a store restored from a backup — get `shipped_at`/`verified_at` cleared and ship again; rows older than the store's purge horizon are pruned) and asks the store to purge past the audit retention class.
5. **Hashing and signatures.** `recordHash = sha256(canonicalJson(record))` over a fixed field set (JCS-style: sorted keys, no whitespace, ISO dates, absent payloads as null, millisecond times); `chainHash = sha256(prevHash ‖ recordHash)` over the two hex strings, genesis `'0' × 64`. Checkpoint signature = Ed25519 over `ocso-audit-checkpoint\n<upToPosition>\n<chainHash>\n<createdAt ISO>`; the key id is the first 16 hex of sha256(SPKI DER). The private key is `AUDIT_SIGNING_KEY_FILE` (Compose keygen generates it) or `AUDIT_SIGNING_KEY` inline (ECS); production refuses to start without one; elsewhere a development key is kept in `<workspace>/.ocso/audit_signing_key.pem` (created on first use with `wx`, so the api and worker under `pnpm dev` share it). Retired public keys (`AUDIT_TRUSTED_PUBLIC_KEYS` inline and/or `_FILE`, PEM bundle) ride on the signer (`retiredKeys`); `trustedKeys(signer)` is what the sealer, verify endpoint, full verification, keys endpoint and bin trust. The same signer is available to the exception report (area EXCEPTIONS) through the `AUDIT_SIGNER` token — the api keeps the private key for that reason (a human signs weekly reports there); only the worker signs checkpoints and exports.
6. **Reads.** `readAudit(store, db, q, scope)` reads the unshipped outbox first, then the store, dedupes by id and merges by `(occurredAt, id)` descending — the audit screen never shows shipping lag; the outbox side includes rows shipped but not yet verified (a lost append stays visible until reconciliation re-ships it). The store query is raced against a 5 s timeout; if the store fails or does not answer, the local window answers (`x-ocso-audit-source: local`) and the web shows a banner. `auditScope(principal)` now returns data, an `AuditScopeFilter`: null for `audit.read_all`, else `{ actorId, teamIds, sharedTargetTypes: queue, sla_policy, team, router, channel, message_template }` (channels and templates belong to no team; routers decide who serves them); every driver applies it itself. `auditTeams(tx, targetType, targetId, actor)` resolves a target's teams through a registry (`registerAuditTeamResolver`) with defaults for agents and their prompt versions, escalation rules, corrections, evaluations and alert rules, conversations and tool calls (agent teams ∪ queue teams), users, teams, queues and approvals; an agent actor adds the agent's teams. Ask OCSO's `recent_changes` reads through the same function with the caller's scope (before, it read the whole log). Recent-window readers (home, markers, System overview, privileged changes) keep reading the main database.
7. **API.** `GET /v1/audit` (audit.read) through the store; `GET /v1/audit/keys` (audit.read or audit.verify; public keys); `GET /v1/audit/store` (system.read or audit.verify; driver, status, lag, backlog, sealed position, last checkpoint, store stats, exports, open incidents); `POST /v1/audit/verify {from?, to?}` (audit.verify; default the latest 10 000 entries, at most 100 000; audited as `audit.verify` with the key ids used); `POST /v1/audit/incidents/:id/acknowledge {note}` (audit.verify; resolves an open `CHAIN_BROKEN` with who/when/why in its detail, audited as `audit.chain_acknowledge`; the store is not changed and later verifications treat that position range as a known break). The status also reports the last full verification and `warnings` from the store's `selfCheck()` (owner/superuser credentials; in production, an api that can write). `/health/ready` does not depend on the store; `/health/dependencies` reports it with the lag. The System screen gains an Audit store panel with **Verify recent entries**.
8. **Provisioning** is the `audit-migrate` bin, run by the migrate step with owner credentials that only the migrate container holds: applies the driver's migrations (`packages/audit-store/migrations/<driver>`, checksummed in `audit_schema_migrations`), creates the audit database if missing (postgres), sets the minimum retention, ensures the writer and (optional) reader roles/users with their passwords and grants; in production it refuses a writer that is the owner/admin or a superuser unless `AUDIT_ALLOW_OWNER_WRITER=true`. `AUDIT_PROVISION_ROLE=false` for managed databases where a DBA created the roles (grants only). `audit-verify [--from N] [--to N] [--public-key FILE]... [--max-unsigned N]` re-verifies any range offline with no entry cap; it rejects non-integer positions (exit 2) and fails (exit 1) on any problem, when no valid checkpoint signs the range, when more than N (default 5 000) entries follow the last one, or when records exist but nothing is sealed; it prints the unsealed backlog and the key ids it trusted.

**Deviations from the design (smallest correct change, each recorded).**

1. *ClickHouse has no `ALTER DROP PARTITION` privilege*: dropping a partition requires `ALTER DELETE`, which also allows row deletes (verified against ClickHouse 26.9). Granting it to the writer would make the api able to delete audit rows. Instead the writer is SELECT/INSERT only, and an optional **purge user** (`CLICKHOUSE_PURGE_USER` / `_PASSWORD`, worker only, SELECT + ALTER DELETE on `audit_records`) runs the retention purge; without it the clickhouse store is never purged (the purge reports an error the retention run logs).
2. *`audit_ensure_partitions(months_ahead, from_ts DEFAULT now())`* takes a second argument so the shipper can create the months of old history (the outbox backfill) before appending; partitions reach ~10 years back at most.
3. *`ChainEntry.recordOccurredAt`* is part of the chain entry, and the contract gains `purgeHorizon()` (the newest logged purge cutoff), so verification counts a missing record as `purged` only when a logged purge removed it; anything else is `RECORD_MISSING`. The contract also gains `selfCheck()` and `ChainRangeItem.forks/conflicts`.
4. *`checkpoints()` also filters by position range* (`fromPosition`, `toPosition`), which verification and exports need.
5. *`unsealed()` order is arrival (ingest) order, not `occurredAt`*: chain order is seal order, and a re-shipped old record must still be sealed. The postgres driver looks for unsealed rows from 10 000 ingest positions behind the sealed watermark (commits can land out of order); clickhouse from an hour behind.
6. *`AUDIT_SIGNING_KEY` inline* in addition to `AUDIT_SIGNING_KEY_FILE` (ECS injects secrets as variables, not files).
7. *Writer = the user in `AUDIT_DATABASE_URL`*: audit-migrate derives the role name (and default password) from the writer URL, so a deployment never names the role twice; `AUDIT_WRITER_PASSWORD` overrides the password.
8. *Terraform* gives the audit store its own RDS instance by default (`audit_store.separate_instance = true`; master `ocso_audit`, whose URL only the migrate task receives). `false` keeps it on the main instance, whose master user the api and worker hold (they could disable the triggers): a `check` block warns on every plan and docs/15 states the weaker boundary.
9. *The api reads with a SELECT-only reader role* (spec §6.5 gave api and worker the same writer credentials). The api never writes to the store; Compose keeps the writer URL in a secrets subpath only the worker mounts.
10. *The signing key on AWS is its own Secrets Manager secret* (`audit_signing_key_secret_arn`, created outside Terraform), not a bootstrap key: a bootstrap rotation can no longer blank or silently replace it.

**Why.** An auditor needs the audit trail to survive the application: separate credentials that cannot rewrite it, evidence (hash chain, signatures, exports) that it was not rewritten by someone who bypassed them, and a way to check that independently. Keeping the same-transaction write in the main database preserves the strongest property the old design had (no change without its audit row), while the store gives separation, volume (ClickHouse for high-volume deployments) and retention independent of operational data. Reconciliation before pruning means the move never loses an event.

**Alternatives.** Write to the store synchronously in the request (a store outage would stop every configuration change, and a crash between the two writes loses one side). Logical replication of `audit_events` to a second PostgreSQL (no chain or signatures, and the replica's permissions mirror the source). A hosted immutable ledger (QLDB-style) or object-lock storage only (vendor-specific; the owner wanted drivers and self-hosting). Merkle trees per checkpoint instead of a linear chain (cheaper inclusion proofs, more code; the linear chain with periodic signed checkpoints meets the auditor's need today). Resolving team scope at read time as before (impossible across two databases; write-time `team_ids` is the price).

**Consequences.**

- *What changes in the guarantee (PM/research/11 §6.6).* Before, the audit row and the change committed together in one database. They still do (the outbox row). The store copy arrives within seconds, at least once, idempotently; it is not atomic with the change. Compensated by outbox atomicity, reconciliation before any local prune, incidents (`SHIP_FAILED`, `STORE_DOWN`, `RECONCILE_MISSING`, `CHAIN_BROKEN`, `EXPORT_FAILED`) on the System screen and for the exception report, and the merged read path.
- *Team scope is fixed when the event is written.* Moving a user or agent between teams does not re-scope history. Platform-wide objects with no team (e.g. a platform escalation rule) are visible to non-Tech readers only through the actor's teams; previously every reader could see them. History from before the store was backfilled without the acting user's teams, so a lead sees a teammate's pre-upgrade action on an unscoped target only if it concerned a team object. `audit.read_all` is unaffected.
- *Deployments gain a database.* Compose: an `audit-db` service (volume `auditdata`, secrets subpath `audit-postgres`); keygen writes the owner URL and both roles' credentials for migrate (`audit-migrate/`), the writer URL into `audit-writer/` (mounted only by the worker), the reader URL into `app/audit_reader_url` (api, demo seed) and the signing key (`app/audit_signing_key` — back it up); the migrate container runs `audit-migrate` after the main migrations; the entrypoint resolves the new `_FILE` settings. Terraform: a second RDS instance (`audit.tf`), bootstrap keys `AUDIT_DATABASE_URL` (writer), `AUDIT_READER_URL`, `AUDIT_DATABASE_OWNER_URL`, the signing key secret ARN with an execution-role read policy, `AUDIT_MIN_RETENTION_DAYS` and `AUDIT_TRUSTED_PUBLIC_KEYS` in the environment. Backups now include the audit database (docs/15 and compose.md §5 carry the restore runbook). Every api/worker start needs `AUDIT_DATABASE_URL` (or the clickhouse settings).
- *Tests.* Every harness (api integration, Playwright stack, resilience stack, the custom-module telemetry test) provisions a throwaway audit database (same server, separate database, a per-run writer role). Application integration tests that only call `recordAudit` need no store (they write the outbox).
- *Key rotation is supported by trust, not re-signing.* Old checkpoints stay signed by the old key; operators keep its public half in `AUDIT_TRUSTED_PUBLIC_KEYS(_FILE)`. A checkpoint by a key not trusted is `CHECKPOINT_UNKNOWN_KEY` in verification and opens `SIGNING_KEY_CHANGED` in the sealer (a lost or silently regenerated key shows up). Exports carry their public key for convenience only: verifiers must pin keys independently (docs/15), and an export is an independent copy only with write-once storage (S3 Object Lock) on `audit-exports/`.
- *A chain break no longer stops sealing or exports.* It is recorded with its position range, later ranges keep being checkpointed and exported, and a person closes it with an audited acknowledgement. There is no automatic "re-anchor" signature over the break: the next checkpoint signs the head hash (which chains through the break), and the incident plus acknowledgement are the record of it.
- *`recordAudit` costs one more query* (the team resolution) inside the caller's transaction.
- *Operational bounds.* Store calls are bounded (15 s; connect 5 s); the sealer verifies at most 50 000 entries per run; full verification pages 50 000 entries a minute; the upgrade backfill is one UPDATE over `audit_events` (minutes per million rows; VACUUM afterwards, documented).

**Spec impact.** docs/15 (implementation notes: retention, audit store — trust boundaries per driver and deployment, keys, restore), docs/operations/compose.md (§2 keygen, §5 backup, §10 the audit store), docs/plugins/infrastructure-drivers.md (the audit store driver kind), .env.example, infra/aws/terraform/terraform.tfvars.example; README (services list) for the integrator.

## ADR-033 — The exception report, storage growth and health roll-ups

**Status:** PROPOSED (2026-09-23) — wave 2, area EXCEPTIONS. Spec: PM/research/11 §7. Related: ADR-029 (permissions), ADR-030 (approvals), ADR-031 (routing), ADR-032 (audit store).

> Amended after adversarial review (see "Amendment 1" at the end): where a bullet below and the amendment differ, the amendment rules.

**Context.**

Maker–checker (ADR-030), per-user permissions (ADR-029) and the audit store (ADR-032) are controls. A bank's
auditor also needs the evidence of where the controls were *bypassed or failed*: configuration live without an
approval, self-approvals, rights granted around approval, routing that could not place customers, messages that
did not arrive, audit events that did not reach the store, a chain that did not verify. The spec asks for a live
view and a weekly report, signed with the audit signing key, exportable, tamper-evident, and scoped by team.
Separately, operators need to know how fast storage grows and when the audit store has outgrown postgres, and the
raw `health_samples` table (one row a minute per component, forever until retention) needed a smaller history.

**Decision.**

*Checks.*
- A registry `EXCEPTION_KINDS` of ten checks `{id, label, severity, description, compute(ctx)}`, each returning items
  `{objectKind, objectId, title, detail, occurredAt, href, teamIds, count}` (spec items plus `teamIds` for scoping and
  `count` for grouped items).
- `live_without_approval` walks `ApprovalRegistry.all()` and subtracts objects with any `APPROVED` proposal from each
  descriptor's `liveObjects()`. It never lists kinds; a new approvable kind is covered by registering its descriptor.
  Titles use the descriptor's projection (checker-visible, never secret); teams come from `descriptor.teamIds()`.
- Every check runs over one `REPEATABLE READ, READ ONLY` snapshot, each in its own savepoint; a check that throws is
  recorded in its section (`error`) and counted in `totals.failedChecks` — a report never silently drops a check.
- Event checks use the period; state checks (live objects, open approvals, standing grants, lag) are judged as of
  generation. Each section keeps at most 500 items and the true `total`.

*Reports.*
- Table `exception_reports` (migration 0028): `kind WEEKLY|ADHOC`, period, `status DRAFT|SIGNED`, `content jsonb`,
  `content_hash` = sha256 hex of canonical JSON (the audit store's `canonicalJson`) computed on the jsonb round-trip,
  generator, signer, note, signature, key id. `UNIQUE (kind, period_start) WHERE kind='WEEKLY'`.
- Trigger: DELETE and TRUNCATE always refused; any UPDATE of a SIGNED row refused; the only UPDATE of a DRAFT is
  signing it, with id/kind/period/content/hash/generator unchanged. CHECK: a SIGNED row carries signature, key,
  signer and time.
- Weekly: the `exception-weekly` leader task (hourly check) freezes the last complete Monday-to-Monday week in the
  deployment time zone (DST weeks are 167/169 h). Idempotent by the unique index and an up-front lookup; one
  `exception_report.generate` audit row and one `exception_report.ready` event per period.
- Ad hoc: `exceptions.sign` holders freeze any ended period of ≤ 31 days starting within the last 90 (the audit
  local window floor, since two checks read `audit_events` locally).

*Signing and export.*
- Signature: Ed25519 with the audit signing key (the api's `AUDIT_SIGNER`) over the spec's message
  `ocso-exception-report\n<id>\n<start ISO>/<end ISO>\n<content_hash>\n<signer user id>\n<signed_at ISO>`.
  The signer sends the content hash they were shown (409 `report_changed` otherwise); signing takes the row lock,
  refuses a signed report (409 `report_signed`) and is audited (`exception_report.sign`, with hash, key, note, totals).
- Every read of a signed report re-verifies it against the trusted keys (current + retired): `VALID`, `INVALID`,
  `UNKNOWN_KEY`, `CONTENT_CHANGED`.
- Export (signed only, signers only, audited `exception_report.export`): a stored ZIP with `report.json` (the signed
  bytes), `items.csv`, `manifest.json`, `signed-message.txt`, `signature.bin`, `public-key.pem`, `VERIFY.txt` with
  `sha256sum` / `openssl pkeyutl -verify -rawin` / key-id steps. `verifyExportBundle` implements the same steps and
  re-derives `items.csv` from `report.json`.

*Scoping.*
- `exceptions.read` sees items whose `teamIds` overlap theirs plus platform-wide items (`teamIds = []`), totals
  recomputed; `exceptions.sign` sees the whole report. Scoped readers never get the signature, sign, or export.

*Storage and health.*
- `storage_samples (day, table_name, rows, bytes)`: the `storage-sample` leader task (hourly, upsert per UTC day)
  samples every main-DB table (exact count under 64 MB, else `reltuples`) and the audit store (`stats()`), kept 400 days.
  `GET /v1/system/storage` (`system.read`): per-table growth over 7/30 days, the total series, the audit store and the
  guidance; the System screen shows a Storage panel.
- Guidance thresholds (`AUDIT_STORE_GUIDANCE`): consider at 50 M records / 50 GiB / 500 k events a day (or projected
  past the recommend line within 180 days); recommend at 250 M / 250 GiB / 2 M a day.
- `health_sample_rollups (hour, component, …)`: the `health-rollup` leader task (5 min) rolls complete hours up per
  component and as an `availability` row (the uptime rule's per-minute verdict for that hour), then prunes raw
  samples older than 48 h in whole, rolled-up hours; roll-ups kept 400 days. `uptime()` adds roll-ups for hours
  before the first raw sample; the test shows the 30-day figure identical before and after the prune.

**Deviations from the spec (smallest correct ones).**

1. **Driver-neutral guidance.** The spec says "ClickHouse guidance"; the plugin-boundary rule forbids core comparing
   driver names. `AuditStore` gains an optional `sizing: {kind: 'row'|'columnar', label}` (set by the postgres and
   ClickHouse drivers; absent = row) and the guidance level is `columnar` instead of "on ClickHouse". Additive edit
   in the AUDIT area's `audit-store/src/{contract,postgres/store,clickhouse/store}.ts`.
2. **prompt_version liveObjects made exact.** A draft agent's prompt activates directly and its go-live approval
   shows the checker the prompt (ADR-030 S5), so the active prompt of an agent taken live after the spine had no
   `prompt_version` approval and read as "live without approval" on every deployment. `liveObjects()` now excludes
   an active version named in an approved agent proposal's after-snapshot (`activePrompt = v<n> · <hash>`). Edit in
   APPROVALS-CORE's `agents/prompt-approval.ts`.
3. **Items carry `teamIds` and `count`** (spec lists six item fields): needed for scoping and grouped items.
4. **Grouping.** `routing_fallback` and `delivery_failures` are grouped (per router+queue+outcome, per
   channel+error, per subscription, per destination) rather than one item per conversation or message.
5. **Extra coverage beyond the listed kinds**, inside them: `approvals_aged` also lists proposals decided late in the
   period and approvals still activating an hour after the decision (11b asked for the latter);
   `routing_fallback` includes blocked routing (`system.routing_blocked`) and refused inbound messages
   (`conversation.inbound_rejected`); `audit_chain` includes `SIGNING_KEY_CHANGED` and failed full verifications;
   `delivery_failures` includes webhook and alert deliveries.
6. **Export needs a signed report and `exceptions.sign`.** A scoped export cannot carry a signature over content the
   reader cannot see; an unsigned export is not auditor-grade.
7. **Ad-hoc reports** exist (spec names the `ADHOC` kind without a flow): signers only, ≤ 31 days, within 90 days.
8. **`routing_fallback` reads `conversation_routing`** (one row per conversation, the latest decision): a conversation
   re-routed later in the week counts once, with its latest outcome. Recorded as a limit.
9. **Storage day is UTC**, not the deployment day.

**Consequences.**

- Auditors get a signed, reproducible, offline-verifiable artefact; the private key stays in the api (as ADR-032
  already decided for this reason).
- The live view recomputes every check on each read. On a large deployment `live_without_approval` projects each
  unapproved object (usually none after the grandfather migration); other checks are indexed range scans
  (`approval_decisions_kind_idx`, `audit_events_time_idx`, …). `delivery_failures` scans interactions of the period
  without a dedicated index on `delivery_status`; acceptable for a weekly job and a 7-day live window, noted.
- Raw health samples drop from ~14 days (operational retention) to 48 hours; alert windows longer than 48 h on
  `database_degraded` see only 48 h.
- Integrator: 0031 must leave `live_without_approval` empty on a migrated database; the check uses exactly each
  descriptor's `liveObjects()`.

### ADR-033 amendment 1 (2026-09-23) — after adversarial review

Two reviewers (correctness/data integrity; security/governance/operability) found that "approved" was too weak,
that weekly periods could overlap or skip, that past periods were read from current or pruned state, and that the
signature did not bind what the signer attested. Decisions:

1. **What "approved" means.** An object is approved live only by an `APPROVED` proposal with action CREATE, UPDATE or
   ACTIVATE and `activated_at` set (MIGRATION records qualify: they are written activated). An approved DELETE or an
   approval still activating does not count. `permission_change` is no longer walked by `live_without_approval`
   (its `liveObjects()` are already "grants without an approved proposal"); `permission_bypass` owns it, so one
   bypass is counted once.
2. **Drift is read from the audit trail, not from snapshots** (new check `changed_outside_approval`, high).
   *Rejected:* comparing `project(now)` with the last approval's `after_snapshot`. Projections deliberately gather
   related objects that change through their own approvals (an agent's `activePrompt`/`promptText` via prompt-version
   proposals, `tools` via tool-grant proposals, `channels` via routing), and MIGRATION rows have no `after_snapshot`;
   the diff would flag every legitimate related change in a critical, signed section. Instead: person-made audit rows
   in the period on a registered kind whose object already had an applied approval, or that took it live
   (`<kind>.activate|go_live|enable`), and that share no correlation id with an approval decision
   (`approval.approve|bootstrap_approve|activate`). Only what the kind governs counts: changes when its descriptor
   lists UPDATE (a user's profile edits are not governed; their access is, under `permission_bypass`), activations
   when it lists ACTIVATE. Stop and operational verbs are exempt (pause, disable, delete,
   discard, reduce, remove, detach, revoke, test, invites, OAuth hand-shakes, provider status, inert drafts).
   Known limit: a never-approved object taken live and stopped within one week through a verb other than
   activate/go_live/enable is visible only in the audit log.
3. **Access increases are judged by their audit rows**, not the caller's opt-in marker: `user.permissions_increased`
   (on an ACTIVE user), `user.activate`, `user.enable` with no `after.proposalId`, plus `approvalSkipped` events.
   Standing grants are listed when their proposal is missing *or not APPROVED* (LEFT JOIN).
4. **MIGRATION/installed approvals are visible** (new `installed_only`, low): per kind, live objects approved only by
   a MIGRATION record. Informational; 0031 will make this large once, by design.
5. **Weekly chain.** No report before `setup_completed_at`. Each weekly period starts at the previous (non-superseded)
   weekly's end and ends at the first local Monday 00:00 at least a day later (`weekAfter`): back-fill after an outage
   (8 per run, oldest first) and one bridging period after a time-zone change. Migration 0028 adds
   `EXCLUDE USING gist (tstzrange(period_start, period_end) WITH &&) WHERE kind='WEEKLY' AND status<>'SUPERSEDED'`;
   the partial unique index gains `AND status<>'SUPERSEDED'`. The task runs every 60 s (two reads when idle).
6. **Regenerate / supersede.** Status `SUPERSEDED` and `superseded_by` (no FK; set in the same transaction that
   inserts the successor). `POST /v1/exceptions/reports/:id/regenerate {reason}` (`exceptions.sign`, audited
   `exception_report.regenerate`). Trigger: only DRAFT→SIGNED or DRAFT→SUPERSEDED (no signature columns), then frozen.
7. **Past periods from history, with coverage.** `routing_fallback` reads the timeline's `system.routed` events
   (also fixes counting continue-route TIMEOUTs as fallbacks); `templates_rejected` in a report reads
   `message_template.status_changed` audit rows. Kinds declare `sources` (`audit`, `conversation`, `operational`);
   each section records `coverage {dataFrom, complete}` from current retention (audit: max(90, local window)).
   *Rejected:* clamping `ADHOC_LOOKBACK` to the smallest retention (1 day at minimum) — it would forbid the
   reports that matter; the incompleteness is recorded, signed and must be acknowledged instead.
8. **Attestation (segregation of duties).** Items carry `actorIds`/`subjectIds`. Signing requires acknowledging each
   flag that applies — `self_attested` (signer is actor/subject of a critical or high item, or a `BOOTSTRAP_APPROVE`
   decided a proposal about them), `failed_checks`, `truncated`, `incomplete_data` — else 409
   `attestation_required {required}`. *Rejected:* refusing self-signing outright or requiring a co-signer — a
   single-Head deployment could then never sign; the flag is signed, audited (`selfAttested`), shown in the list,
   the report and the export.
9. **Signed message** = the spec's six lines + `attestation:<flags|none>` + `note-sha256:<hex|none>`. The report's kind
   is inside the content (`format: ocso-exception-report/2`, `kind`). Exports can no longer re-label a note or kind.
10. **Keys.** `public_key_pem` stored at signing (trigger-frozen). Verification uses the stored key; trust is separate
    (`keyTrust: CURRENT|RETIRED|UNKNOWN`, in the UI and `manifest.json`). Export works after rotation. Without a
    configured key the detail returns `signBlocked: 'signing_key_unavailable'` and the screen says so.
11. **Scoping.** Items may carry `readableWith` (access items: `users.read`) — Tech sees every person's bypass.
    Sections store per-audience counts (`scopes`), so scoped totals are exact when the list is capped; the report cap
    is 5,000 per check (live view 500). `exception_report.ready` no longer carries the item count. An item whose
    teams cannot be read gets the `restricted` team (signers only), never platform-wide.
12. **Robustness.** Descriptor calls inside a check run in their own savepoints. A failed check stores an error class
    (`db_error:<sqlstate>`, `timeout`, `domain:<code>`, `check_failed`); the message goes to the server log only.
    Delivery errors keep their first line (≤120 chars). `verifyExportBundle` never throws on a damaged manifest.
13. **Report hygiene** (new `report_hygiene`, medium) instead of default alert rules: weekly overdue >30 h after the
    week, weekly unsigned 7 days after, unsigned reports with failed checks. *Deferred:* alert rules belong to the
    alerts area; the check makes the lapse visible in the live view and the next report meanwhile.
14. **Health retention.** Operational retention no longer deletes `health_samples` newer than the last rolled-up
    `availability` hour (edit to `retention/retention.ts`, retention area).

Not changed: the per-check cap still exists (5,000) — a child table of items was judged disproportionate; truncation
is flagged, signed and acknowledged. Duplicates between a standing grant and the audit event that created it (both in
`permission_bypass`) remain: they are different facts (state vs event).

## ADR-034 — Third-party plugins and the chat SDK: public contracts, pinned in-process loading, web chat auth modes

**Status:** Accepted, 2026-09-23. Extends ADR-028 (the plugin boundary).

**Context.** ADR-028 made every per-kind implementation a plugin behind a contract, registered at compile time. Adopters
need to add channels and providers without forking, and to build their own chat UI on OCSO with their own users signed in.

**Decision.**
1. **Public contract package.** `@winsendotai/ocso-plugin-sdk` (Apache-2.0, ESM, zero runtime dependencies) carries the
   public copy of four contracts: channels, model providers, alert destinations and email drivers, with `apiVersion: 1`,
   `definePlugin`, `pluginError` (a marker OCSO translates into its typed errors at the boundary) and a `/testing`
   `checkPlugin` that runs the registries' validations. Drivers for blob, secrets, queue, deployment and the audit store,
   tool providers, alert conditions, scheduled tasks and Ask OCSO tools stay internal until their contracts stop needing
   `@ocso/db`/`@ocso/config`. A type-level guard (`packages/bootstrap/test/sdk-conformance.types.ts`) fails CI when an
   internal contract drifts from its public copy; an agreement test runs `checkPlugin` and the registries side by side.
2. **Loading: in-process, pinned, fail closed.** `OCSO_PLUGINS=name@exactVersion,…` from `OCSO_PLUGINS_DIR`. The installed
   version must equal the pin, `apiVersion` must be supported, the name must not clash, every contribution must pass
   validation, and the entry must resolve inside the package (Node's `import` resolution); otherwise the process refuses
   to start. api, worker and seed load the same list and log it; the System page lists installed plugins. Plugins run with
   full trust (no sandbox in v0.1): operators install only code they trust. An out-of-process transport is left open.
3. **Chat SDK.** `@winsendotai/ocso-chat` (headless, browsers and React Native, SSE with a polling fallback) and
   `@winsendotai/ocso-chat-react` (hooks, themeable web components with `'use client'`, a `/native` entry) speak the public
   web chat API directly (CORS per channel allowlist) instead of the iframe widget, which stays.
4. **Web chat auth modes** per channel: `anonymous` (today), `client` (the host's backend mints a single-use, short-lived
   session pass with the channel's secret key, HMAC with an HKDF-derived key), `user` (the host's own login token,
   verified against its JWKS with issuer and audience, or HS256 with a shared secret). Requests without `Origin` (native
   apps, servers) are refused in anonymous mode unless "allow native apps" is set. Host context is filtered by an
   allowlist and size cap and shown to the agent labelled verified (from the host) or unverified (from the browser).
   Tool identity: OCSO-signed customer claims by default; `passthrough` stores the verified user token encrypted until its
   own expiry and forwards it only to MCP connections with `forward_user_token` (an approvable setting). Verified user ids
   are namespaced per channel (`<channelId>:<sub>`, migration 0033), and a verified user never inherits another user's
   visitor id or customer. All new settings are channel settings, so the maker–checker spine governs them (ADR-030).
5. **Rate limits** on the public web chat routes (per address, per visitor; failed session-pass mints per channel and
   address; successful mints unlimited because the caller proved the secret key).

**Consequences.** Adopters can ship channels and providers as npm packages and embed chat natively. In-process plugins
can do anything the api/worker can; the trust statement is explicit in `docs/plugins/installing.md`. The public contract
is now a compatibility promise: breaking it means `apiVersion: 2`. Migrations 0032 (host context, held user tokens,
single-use passes, `forward_user_token`) and 0033 (per-channel verified ids) are additive and data-only respectively.
