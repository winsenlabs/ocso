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

## ADR-003 — TypeScript toolchain and module system

**Status:** PROPOSED — pending `research/04` (TypeScript 7 native compiler vs decorator metadata required by NestJS DI).

---

## ADR-004 — ORM and migrations

**Status:** PROPOSED — pending `research/04`. Requirements: SQL migrations committed to the repo, strong types, transactions with `SELECT … FOR UPDATE SKIP LOCKED`, raw SQL escape hatch, no runtime codegen; migrations run only by the explicit `migrate` deploy step (docs/13 §5).

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

## ADR-020 — Browser → API through same-origin proxy

**Status:** PROPOSED — pending verification that Next.js 16 proxies SSE without buffering; fallback is a path-routing reverse proxy (ALB rules on AWS).

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
