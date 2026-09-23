# OCSO Build Plan

Living implementation plan for OCSO — Open Customer Service Orchestrator.

- **Spec sources:** `README.md`, `docs/00-INDEX.md` … `docs/99-BUILD-RULES.md`, `design/*.dc.html` + `design/shared/*.css`.
- **Architecture decisions:** `PM/ARCHITECTURE-DECISIONS.md` (ADR-NNN references below).
- **Research notes:** `PM/research/*.md` (verified against upstream docs/type definitions, Sep 2026).
- **Branch:** `build/ocso-v1`.

## Status legend

| Status | Meaning |
|---|---|
| NOT STARTED | No implementation yet |
| IN PROGRESS | Implementation underway |
| BLOCKED | Cannot proceed; blocker recorded inline |
| COMPLETE | Implementation, migrations, tests, UI (where relevant) and docs done and verified by running |

A task is only COMPLETE when its acceptance criteria are demonstrated by an automated test or a recorded manual run. Anything that needs a real third-party credential is COMPLETE when adapter + config + validation + contract tests + setup docs exist, and the item notes `needs credential for live verification`.

## Invariants (checked on every task)

1. Single-tenant, multi-user. No tenant IDs, tenant middleware or tenant switching.
2. No CLI product surface. Operation happens via web UI, HTTP APIs, MCP and the internal OCSO agent. (Container entrypoints for `api`, `worker`, `migrate` are deployment mechanics, not a product CLI.)
3. PostgreSQL is durable truth; caches and worker memory are derived.
4. Virtual agent ≠ worker.
5. Authorization is enforced in code at every boundary, including the internal agent and every tool call.
6. External systems stay behind MCP/tool adapters; infrastructure stays behind adapters (`ModelProvider`, `ChannelAdapter`, `ToolProvider`, `QueueAdapter`, `BlobStore`, `SecretStore`, `TelemetrySink`, `DeploymentAdapter`, `AlertDeliveryAdapter`).
7. No monolith files (aim < 300 lines, justify > 400).
8. Secrets never reach prompts, logs, traces, tool-call audit payloads or browser responses.

---

## Phase overview

| Phase | Name | Exit criterion | Status |
|---|---|---|---|
| P0 | Research & planning | Research notes, BUILD-PLAN, ADRs committed | COMPLETE |
| P1 | Foundation | `docker compose up` yields healthy web/api/worker/db; login works for all three roles | COMPLETE — foundation, auth/RBAC, web foundation, Compose verified end to end |
| P2 | Conversation spine | Customer holds a persistent multimodal web-chat conversation with a named agent (mock model) | COMPLETE — spine, web chat API + widget, workspace; e2e |
| P3 | Agent runtime & prompt compiler | Robust persistent streamed turns via AI SDK behind OCSO interfaces; prompt versions; summaries; usage | COMPLETE — compiler, versions (UI), turns, summaries, usage, streaming |
| P4 | Provider fleet & caching | Six provider adapters, logical profiles, policy-bound fallback, provider prompt caching + OCSO turn cache with metrics | COMPLETE — six adapters with per-provider caching, profiles UI, fallback, turn cache; live checks need credentials |
| P5 | MCP & tools | Admin connects an MCP server (OAuth 2.1), approves tools; agent calls tools safely with authorization + confirmation | COMPLETE — MCP manager + UI, OAuth 2.1, authorization, confirmation, customer claims |
| P6 | WhatsApp & channel behavior | Production-style WhatsApp channel: verification, identity, media, delivery status, idempotency | COMPLETE — WhatsApp adapter, webhooks, channel setup UI; live check needs a Meta number |
| P7 | Human operations | Full AI → human → AI lifecycle with pickup, auto-assign, notes, SLA, copilot | COMPLETE — lifecycle, workspace, copilot, SLA (pickup + resolution) |
| P8 | Observability & alerts | Role-specific telemetry; alert engine with dedupe, lifecycle and pluggable delivery | COMPLETE — telemetry, analytics, quality, alerts, webhooks with screens and e2e |
| P9 | Internal OCSO agent | Permissioned conversational operation of OCSO with confirmation + audit | COMPLETE — internal agent backend + drawer |
| P10 | Scaling & AWS production | Leases/recovery hardened; SQS/S3/Secrets Manager adapters; ECS Fargate Terraform; autoscaling adapter; load + chaos tests | COMPLETE — SQS/S3/Secrets Manager, Terraform, deployment adapter, chaos + load tests; AWS apply pending an account |
| P11 | Hardening & release | Full e2e suite, security review, docs, operator runbooks | IN PROGRESS — security fixes, retention, operator guides, docs sync, full e2e (63 tests) done; remaining items listed in DEFINITION-OF-COMPLETE.md caveats |

Phases are vertical slices: each includes persistence, authorization, API, UI where relevant, tests and observability (build rule §22).

---

## P0 — Research & planning

### E0.1 Upstream research — COMPLETE
| ID | Task | Status |
|---|---|---|
| T0.1.1 | AI SDK v7 + all six provider packages, per-provider prompt-cache matrix, usage normalization → `research/01-ai-sdk-and-providers.md` | COMPLETE |
| T0.1.2 | Vercel Chat SDK + WhatsApp Cloud API → `research/02-chat-sdk-and-whatsapp.md` | COMPLETE |
| T0.1.3 | MCP client/server + OAuth 2.1 authorization → `research/03-mcp-and-oauth.md` | COMPLETE |
| T0.1.4 | NestJS 12, Next.js 16, TypeScript 7, ORM/migrations, validation, testing, OpenTelemetry, pnpm/turbo → `research/04-backend-frontend-stack.md` | COMPLETE |
| T0.1.5 | SQS, ECS Fargate autoscaling, S3, Secrets Manager, Terraform, Compose, OTel→CloudWatch → `research/05-aws-deploy-and-queues.md` | COMPLETE |

### E0.2 Planning artifacts — IN PROGRESS — living documents, updated as work lands
| ID | Task | Status |
|---|---|---|
| T0.2.1 | `PM/BUILD-PLAN.md` (this file) | IN PROGRESS |
| T0.2.2 | `PM/ARCHITECTURE-DECISIONS.md` | IN PROGRESS |
| T0.2.3 | Traceability: spec requirements ↔ tasks (see bottom of this file) | IN PROGRESS |

---

## P1 — Foundation

### E1.1 Monorepo & toolchain — COMPLETE — monorepo, toolchain, source guards (lint) and CI workflow
**T1.1.1 Workspace scaffold** — NOT STARTED
- Subtasks: pnpm workspace + catalogs; turbo pipeline (`build`, `typecheck`, `lint`, `test`, `test:int`); strict base tsconfig; ESLint + Prettier; `.editorconfig`; `.nvmrc`; `.env.example`.
- Layout: `apps/{api,worker,web}`, `packages/{domain,contracts,db,events,queue,auth,secrets,blob,config,observability,prompt-compiler,model-providers,agent-runtime,channels,mcp,alerts,deployment}`, `examples/mcp-bank-demo`, `infra/{compose,aws}`.
- Depends: T0.1.4 (toolchain ADR).
- Acceptance: `pnpm install && pnpm build && pnpm typecheck && pnpm test` green on a clean clone.
- Tests: CI smoke of the four commands.

**T1.1.2 File-size & boundary guard** — NOT STARTED
- Subtasks: script (run in `pnpm lint`) that fails on hand-written source > 500 lines and warns > 300; dependency-direction rules (domain has no infra imports; apps never import another app; packages never import `apps/*`); circular-import check.
- Acceptance: lint fails on a synthetic violation.
- Tests: unit test for the guard script.

**T1.1.3 CI workflow** — NOT STARTED
- GitHub Actions: install, lint, typecheck, unit, integration (Postgres service), web build, e2e (Playwright) on PR.

### E1.2 Configuration, logging, errors — COMPLETE
**T1.2.1 Typed configuration** (`packages/config`) — zod-validated env for api/worker/web; adapter selection (`QUEUE_DRIVER=postgres|sqs`, `BLOB_DRIVER=local|s3`, `SECRETS_DRIVER=local|aws`, `DEPLOYMENT_DRIVER=compose|ecs`); fail-fast with readable errors. Tests: invalid config rejected; secrets never echoed in error output.

**T1.2.2 Typed error model** (`packages/domain/errors`) — categories from docs/14 §5 (validation, authentication, authorization, not_found, conflict, provider_unavailable, provider_rate_limited, tool_unavailable, tool_rejected, timeout, policy_denied, capacity, internal); Nest exception filter mapping to HTTP + stable error codes; never leak raw provider exceptions. Tests: mapping table unit test.

**T1.2.3 Structured logging** (`packages/observability`) — pino JSON with redaction paths for secrets/tokens/authorization headers; correlation fields (request_id, conversation_id, turn_id, worker_id, trace_id). Tests: redaction unit test.

### E1.3 Database foundation — COMPLETE
**T1.3.1 ORM + migration tooling** — per ADR-004; migrations committed as SQL; `migrate` entrypoint run as an explicit deploy step (Compose one-shot service / ECS one-off task), never on app startup.
**T1.3.2 Core schema v1** — users, sessions, teams, team_members, deployment_settings, audit_events (append-only enforced by trigger), outbox/event tables. Later phases add their own migrations.
**T1.3.3 Test database harness** — per-suite database creation against local Postgres or Testcontainers; migrations applied; truncate helpers.
- Acceptance: `migrate` idempotent; audit_events UPDATE/DELETE rejected by DB.
- Tests: migration up on empty DB; audit immutability integration test.

### E1.4 API & worker skeletons — COMPLETE
**T1.4.1 NestJS API app** — bootstrap, raw body for webhooks, validation pipe (zod), exception filter, request-id + OTel correlation, `/health/live`, `/health/ready` (DB), `/health/dependencies` (queue, blob, secrets, providers, MCP — informational, never fails liveness).
**T1.4.2 NestJS worker app** — standalone application context; worker registration row + heartbeat; graceful drain on SIGTERM; `/health/live` + `/health/ready` on a small internal port for container health checks.
**T1.4.3 Module boundaries** — Nest module per domain area (auth, users, teams, agents, prompts, customers, conversations, interactions, handoffs, assignments, queues, channels, mcp, tools, models, usage, alerts, analytics, telemetry, system, internal-agent, audit); contracts exported via explicit `*.module.ts` exports only.
- Tests: health endpoints e2e; worker heartbeat integration test.

### E1.5 Authentication & RBAC — COMPLETE — API RBAC + route-access test, web login/setup with Playwright role flows
**T1.5.1 Local authentication** — email + password (argon2id/scrypt per ADR), server-side sessions (hashed token, HttpOnly SameSite cookie, rotation, expiry, revoke), login rate limiting, audit of security events. *(Replaced by Better Auth in E11.6 / ADR-025.)*
**T1.5.2 First-run setup** — when no users exist, `/setup` in the web UI creates the first Platform Tech Admin using a one-time setup token printed to the API log / provided via env. No CLI.
**T1.5.3 Permission model** (`packages/auth`) — explicit `Permission` catalogue; role → permission matrix for PLATFORM_TECH_ADMIN, CS_LEAD, CS_EXEC; `Principal` type; resource policies (conversation access by queue/team membership/assignment; agent-scoped lead access).
**T1.5.4 Enforcement** — Nest guard + `@RequirePermission()` on every controller route; service-level `authorize(principal, action, resource)` for resource checks; default-deny test that enumerates every route and asserts a permission annotation.
**T1.5.5 Users & teams management** — CRUD for users (Tech Admin: all roles; CS Lead: CS Execs/teams per policy), role changes audited, deactivate/reactivate.
- Tests (required): RBAC matrix unit tests; route-coverage test; resource-policy tests (exec cannot read conversation outside their queues); role-change audit.

### E1.6 Web foundation — COMPLETE — design system, shell, role-aware nav, team/settings pages; 13 Playwright tests
**T1.6.1 Next.js app** — App Router, standalone output, API proxy (same-origin `/api/*`), session handling, protected layout, role-aware nav.
**T1.6.2 Design system port** — `design/shared/{base,one,charts,mock,ocso}.css` imported verbatim as the canonical visual layer; fonts (Inter, JetBrains Mono); light/dark theme toggle.
**T1.6.3 Shared UI primitives** (`apps/web/components/ui/*`) — Sidebar/OCSONav, Topbar, PageHead, SecHead, Tabs, StatusChip (`schip`), ControlState (`cstate`), SlaTimer (`sla`), ChannelMark, RiskBadge, Tile/Tiles, MetricMatrix (`mtx`), HBar chart (`hb`), Sparkline/LineChart (SVG), DataTable (`dtable`), KV list, Alert banner, Drawer (`rdrawer`), Modal + Stepper, Timeline events (`ev`, `sysev`, `toolev`), PromptComponentCard (`pcomp`), VersionRow (`vrow`), ProviderCard (`pvd`), McpConnectionRow, ConfirmCard (`confirm`), Copilot card, Empty state, Filter chips (`fchip`).
**T1.6.4 Login + setup screens**.
- Acceptance: primitives render identically to design mockups (visual check against `design/*.dc.html`).
- Tests: component unit tests for state → class mapping; Playwright login for each role.

### E1.7 Local deployment — COMPLETE — Dockerfile, Compose (keygen, migrate, profiles), demo seed; verified end to end
**T1.7.1 Dockerfiles** — multi-stage per app (api, worker, web) from the pnpm monorepo; non-root; healthchecks.
**T1.7.2 `compose.yaml`** — web, api, worker, postgres, migrate (one-shot, `service_completed_successfully`), optional profiles: `demo` (mock MCP bank server + demo seed), `observability` (OTel collector + Jaeger), `s3` (S3-compatible store if chosen in ADR-011).
**T1.7.3 Compose docs** — `.env.example`, volumes, backups, upgrades/migrations, secret handling, one-command start.
- Acceptance: `docker compose up -d` → all services healthy; login works.
- Tests: scripted compose smoke test (health endpoints + login).

---

## P2 — Conversation spine

### E2.1 Domain core — COMPLETE
**T2.1.1 Conversation control state machine** (`packages/domain/conversation`) — states AI_ACTIVE, ESCALATION_REQUESTED, WAITING_FOR_HUMAN, HUMAN_ACTIVE, AI_RESUMING, RESOLVED; explicit transition table with guard + actor requirements; business status orthogonal; derived `control_mode`.
- Tests (required): exhaustive transition table test (every allowed + every rejected transition).

**T2.1.2 Canonical interaction model** — Interaction + typed parts TEXT, IMAGE, AUDIO, VIDEO, DOCUMENT, LOCATION, CONTACT, STRUCTURED, TOOL_RESULT; zod schemas shared by channels/API/runtime; visibility (CUSTOMER vs INTERNAL); actor types CUSTOMER/AGENT/HUMAN/SYSTEM/TOOL.

**T2.1.3 Event envelope & catalogue** (`packages/events`) — `OCSOEvent<T>` (id, type, version, occurredAt, correlationId, conversationId?, agentId?, payload); versioned catalogue from docs/02 §8; transactional outbox; realtime fan-out (Postgres LISTEN/NOTIFY per ADR-009) to SSE.

### E2.2 Persistence (migration 0002) — COMPLETE
Tables: virtual_agents, customers, customer_identities, channels, conversations, interactions, interaction_parts, internal_notes, turns, conversation_summaries, jobs (Postgres queue), conversation_leases, workers.
- Indexes per docs/03 §5.
- Tests: repository integration tests; identity uniqueness; interaction idempotency key uniqueness.

### E2.3 Virtual agents (basic) — COMPLETE — API + /agents screens (list, overview, settings) with e2e
CRUD + status (DRAFT/LIVE/PAUSED), purpose/type, channel assignment, default queue, multimodal settings, business hours; CS Lead permissions; audit.

### E2.4 Customers & identity resolution — COMPLETE — resolution/relink, API, /customers page (visibility-scoped conversation list)
Deterministic resolution `(channel_type, provider_identifier) → CustomerIdentity → Customer`; create-on-first-contact; merge/link identities (audited); customer context attributes; customers list/detail UI.
- Tests: resolution determinism; concurrent first-contact race (unique constraint + retry).

### E2.5 Ingress pipeline — COMPLETE
Channel-neutral `IngressService`: verify → normalize → resolve identity → find/create conversation → persist interaction + parts idempotently → enqueue turn when AI owns the conversation → emit events.
- Tests (required): duplicate webhook delivery produces exactly one interaction and one turn.

### E2.6 Queue abstraction v1 — COMPLETE
`QueueAdapter` contract (publish with groupKey/dedupeKey/delay; consume with concurrency, ack/nack/extend; stats for depth/age); Postgres implementation (SKIP LOCKED, visibility timeout, retries with backoff, DLQ status, delayed jobs, lease-aware affinity claim).
- Tests: contract test suite runnable against every implementation; concurrency test (N consumers, no double processing).

### E2.7 Worker turn execution v1 — COMPLETE
Consume `conversation.turn` → acquire lease → gather unprocessed customer interactions → run agent runtime (mock model in this phase) → persist response interaction → outbound delivery job → release/refresh lease.

### E2.8 Web chat channel — COMPLETE — public API + embeddable widget (AI SDK UI transport, origins, attachments) with e2e
- Public widget page `/webchat/[channelKey]` (embeddable), visitor identity (signed visitor token; optional host-app JWT for authenticated customers), attachments (image/document), streaming via AI SDK UI `useChat` with an OCSO transport, resume on reload, human replies delivered live.
- API: `POST /public/webchat/:channel/messages`, `GET /public/webchat/:channel/stream` (SSE), history, attachment upload via BlobStore.
- Tests: widget e2e with mock model; identity token validation.

### E2.9 Blob storage v1 — COMPLETE
`BlobStore` contract; local filesystem driver (Compose); MIME sniffing + allowlist, size limits, signed short-lived download URLs through the API, retention metadata.

### E2.10 CS workspace (read + live) — COMPLETE — workspace inbox, timeline, realtime; e2e against API + worker
Conversation list + timeline + context rail reproducing `design/01`; SSE live updates.

**P2 exit:** customer holds a persistent multimodal web-chat conversation with "Maya"; history survives api/worker restart.

---

## P3 — Agent runtime & prompt compiler

### E3.1 Model provider contract — COMPLETE
`ModelProviderAdapter { stream, generate, capabilities, health }` in `packages/model-providers`; OCSO-owned request/response/stream-event types (no AI SDK types leak across the boundary); normalized usage `{ inputTokens, outputTokens, cachedInputTokens, cacheWriteTokens, reasoningTokens, latencyMs, ttftMs, providerRequestId }`; normalized errors.
- Tests (required): adapter contract suite (shared, run per adapter).

### E3.2 AI SDK integration — COMPLETE
Generic AI-SDK-backed adapter core: message mapping (OCSO parts → AI SDK content parts incl. images/files/audio), tool schema mapping (JSON Schema), streaming with TTFT measurement, abort/timeout, step results; OCSO executes tools (no SDK auto-execute) so authorization runs in OCSO code.

### E3.3 Prompt compiler — COMPLETE
`packages/prompt-compiler`: ordered components (runtime contract, identity, objective, behavior, policies, tool instructions, escalation policy, channel constraints, stable business context | customer context, rolling summary, recent turns, current turn); stable-prefix boundary + cache breakpoint markers; per-component and prefix hashes; token estimates; untrusted-content delimiting (customer text, tool descriptions/results); never interpolates secrets.
- Tests (required): deterministic output; ordering; hash stability; prefix unchanged when only dynamic content changes; injection delimiting.

### E3.4 Prompt versioning — COMPLETE — service, API, prompt editor, versions/diff/activate/rollback, replay; tests + e2e
Immutable `prompt_versions` (components, component hashes, compiled hash, author, timestamp, reason, parent, changed components); drafts; activation (audited) with RBAC split (CS Lead: business components; runtime contract platform-owned; tool schemas Tech Admin); diff between versions; rollback = activate older version.
- UI: Prompt tab + Versions tab (`design/02`).
- Tests (required): versions immutable; activation audit; permission boundaries per component.

### E3.5 Tool loop — COMPLETE
Multi-step loop with step limit; built-in OCSO tools (`ocso.request_handoff`, `ocso.search_history`, `ocso.set_conversation_attributes`); tool errors typed and summarized for the model (no raw exceptions); durable checkpoints (tool request persisted before side effect; result after).

### E3.6 Rolling summary & context compaction — COMPLETE
Summary job (summarizer profile) when unsummarized interactions exceed threshold; versioned summaries with `covers_through_seq`; recent-turn window; `ocso.search_history` retrieval of older evidence.

### E3.7 Usage accounting — COMPLETE — usage events per request incl. COPILOT; telemetry views under E8.2
`usage_events` per model request (purpose TURN/SUMMARY/COPILOT/INTERNAL_AGENT/CLASSIFIER), linked to turn/conversation/agent/profile/provider; cost metadata from a pricing table maintained by Tech Admin.

### E3.8 Turn concurrency policy — COMPLETE
Per-agent setting `QUEUE_BEHIND` | `CANCEL_AND_RESTART` for customer messages arriving mid-turn; cancellation only before customer-visible output or side-effecting tool execution; deterministic; audited in turn records.
- Tests (required): both policies; no duplicate replies.

**P3 exit:** streamed, persisted, versioned-prompt turns with summaries and usage accounting.

---

## P4 — Provider fleet & caching

### E4.1 Provider adapters — COMPLETE — contract-tested with recorded fixtures; live verification needs customer credentials
One module per provider, registered in a provider registry (no central switch):
| ID | Provider | Notes | Status |
|---|---|---|---|
| T4.1.1 | AWS Bedrock | IAM role / access keys via SecretStore; region; Converse API models | NOT STARTED |
| T4.1.2 | Google Vertex AI | service account JSON via SecretStore; project/location; Gemini + Anthropic-on-Vertex | NOT STARTED |
| T4.1.3 | Microsoft Foundry | endpoint + key / Entra app; deployment names; per ADR-006 | NOT STARTED |
| T4.1.4 | OpenAI API | API key; org/project | NOT STARTED |
| T4.1.5 | Anthropic API | API key | NOT STARTED |
| T4.1.6 | Sarvam API | subscription key; per ADR-006 | NOT STARTED |
| T4.1.7 | Dev-only scripted provider | deterministic mock for local demo + tests; disabled unless `OCSO_ENABLE_DEV_PROVIDERS=true` | NOT STARTED |
- Each: config schema + validation, capability declaration, health check, "Test call" endpoint, contract tests with recorded provider-format HTTP fixtures (no live credentials needed), setup docs. Live verification needs credentials.

### E4.2 Provider prompt caching — one task per provider — COMPLETE — per-provider caching implemented and tested for all six; live hit-rate verification needs credentials; Sarvam caching not documented by vendor (reported as unsupported until observed)
Driven by `research/01` prompt-cache matrix. Each adapter maps the compiler's stable-prefix/breakpoint markers to the provider's native mechanism and maps provider cache metrics into normalized `cachedInputTokens` / `cacheWriteTokens`.
| ID | Provider | Mechanism (confirm in research/01) | Status |
|---|---|---|---|
| T4.2.1 | AWS Bedrock | `bedrock.cachePoint` after stable system (covers tools) + context/history boundaries; ≤ 4; TTL 5m/1h; usage `cacheReadInputTokens`/`cacheWriteInputTokens` | NOT STARTED |
| T4.2.2 | Google Vertex AI | Gemini implicit prefix caching (reads only; writes not reported); Claude-on-Vertex `anthropic.cacheControl` | NOT STARTED |
| T4.2.3 | Microsoft Foundry | Azure OpenAI `azure.promptCacheKey` + retention/breakpoints; Claude-on-Foundry `anthropic.cacheControl` via native endpoint | NOT STARTED |
| T4.2.4 | OpenAI API | automatic + `openai.promptCacheKey` (per agent prefix hash), retention / 5.6+ explicit breakpoints; cache writes billed on 5.6+ | NOT STARTED |
| T4.2.5 | Anthropic API | explicit `cacheControl` breakpoints (≤ 4) on stable system, conversation context, history tail | NOT STARTED |
| T4.2.6 | Sarvam API | no documented control; map `cached_tokens` if returned; capability `unverified`; UI shows "no documented cache support" | NOT STARTED |
- Tests (required): per provider — request carries correct cache directives; usage fixture maps to normalized cache metrics; cache policy `OFF` removes directives.

### E4.3 Logical model profiles — COMPLETE — API + profiles UI with live policy validation
`model_providers` + `model_profiles` (provider, model, region, timeout, temperature/reasoning, max output tokens, retry policy, cache policy, ordered fallbacks, capability requirements); agents reference profiles only; profile edit audited and triggers cache invalidation. UI: providers + profiles + New profile dialog (`design/04`).

### E4.4 Fallback policy — COMPLETE
Pure policy engine: candidate ordering; filters for provider allowlist, data-residency zone, cross-provider/cross-region permissions, capability requirements, cost ceiling; retriable-error classification; never after customer-visible streaming started; every fallback emits `model.fallback` event + usage record + audit entry.
- Tests (required): residency violation blocked; allowlist blocked; capability mismatch blocked; retriable vs non-retriable; audit emitted.

### E4.5 OCSO turn/context cache — COMPLETE
Derived cache of compiled stable prefix, effective tool schema set + hash, customer context, rolling summary, recent-turn bundle; two tiers (worker in-memory LRU for leased conversations + Postgres snapshot for recovery); keys composed from content hashes/version IDs; invalidation on prompt activation, tool/schema change, policy change, material customer-context change, model/cache config change, channel behavior change (generation counters + NOTIFY + hash validation at read).
- Metrics: OCSO cache hit/miss per layer, rebuild time.
- Tests (required): each invalidation trigger; stale entry never served after hash change; worker recovery with cold cache.

### E4.6 Provider concurrency limits — COMPLETE — per-process semaphore per provider
Per-provider max in-flight requests (Tech Admin); worker-local semaphore + deployment-wide budget; backpressure surfaced as capacity errors and queue delay, not failures.

### E4.7 Model discovery, catalog prices and spend budget (ADR-027) — COMPLETE — Vertex/Bedrock listings built to documented shapes; live check owed
- `listModels()` on the adapter contract for all kinds (OpenAI/Anthropic `/v1/models`, Bedrock foundation models + inference profiles, Vertex Model Garden, Foundry configured deployments, Sarvam `/models` with catalog fallback, DEV_SCRIPTED).
- `GET /v1/model-providers/:id/models`: 10-minute cache, admin refresh, typed errors without keys, catalog metadata and prices.
- Open-source catalogs as the price and metadata source (models.dev primary, LiteLLM fallback). Daily worker refresh through the SSRF guard plus a host allowlist; snapshots in `model_catalog_snapshots`; vendored offline snapshot plus `scripts/refresh-model-catalog.mjs`.
- `model_pricing` origin `catalog` | `manual`, catalog source/date, long-context tiers. Profile save pre-fills catalog prices; refreshes move catalog rows (audited); admin edits become manual.
- `GET /v1/model-pricing/missing` and `POST /v1/model-pricing/from-catalog`. Telemetry shows unpriced usage as "no price".
- Alert condition `spend_budget_above` (TECHNICAL, agent-scoped): month-to-date spend in the deployment timezone, once per threshold per month, month-end projection, resolves at rollover.
- Web: searchable model picker for the primary and each fallback, a post-save price review, and the pricing section with origin, source, catalog status and models without a price.
- Tests: unit tests for listings, filters, normalization, mapping, costing and web mapping; integration tests for the API model list and pricing, catalog refresh and price sync, and the budget evaluator.

**P4 exit:** changing a profile's provider requires no agent change; cache metrics visible per provider/profile.

---

## P5 — MCP & tools

### E5.1 MCP connection manager — COMPLETE — wizard, OAuth 2.1, health, drift; UI with e2e against the demo server
Wizard (`design/04` six steps): enter URL → discover (initialize, server info, capabilities, tools with pagination) → authenticate (none / static header / OAuth 2.1 with PKCE, protected-resource + AS metadata discovery, client registration per spec, resource indicators, token refresh) → review tools (risk class seeded from annotations; admin classifies) → approve (scope SHARED/USER, agents allowed, confirmation policy) → active (health checks, schema sync).
- SSRF protection: scheme/host validation, private-range and metadata-IP blocking unless connection network = INTERNAL and host allowlisted; redirect limits.
- Tokens stored only in SecretStore; DB holds refs.

### E5.2 User-scoped connections — COMPLETE — personal connections backend + My connections tab
Per-user OAuth connections for USER-scope servers; effective tool resolution includes current user's connections where relevant (human tool actions, internal agent).

### E5.3 Tool registry & schema sync — COMPLETE — drift un-approves changed tools
Normalized tool records (qualified name, description treated as untrusted data, input schema + hash, annotations, risk class READ/WRITE/SENSITIVE, approval); re-discovery diff with approval of changed/added tools; schema change triggers turn-cache invalidation.

### E5.4 Tool authorization — COMPLETE
Deterministic `ToolAuthorizer`: tool exists → connection usable → agent allowed → acting principal allowed → scope allowed → argument schema valid → confirmation satisfied → argument policy rules (e.g. amount > limit ⇒ confirmation/deny).
- Tests (required): each rejection path; model cannot self-authorize via arguments or prompt text.

### E5.5 Sensitive action confirmation — COMPLETE — hold/confirm/deny/expiry + workspace confirmation card (e2e)
`tool_calls` AWAITING_CONFIRMATION; agent informs customer/hand-off per policy; CS Exec "Confirm and run" in workspace executes with human attribution; expiry; audit.
- Tests (required): confirmation required; denial; expiry; audit.

### E5.6 Customer identity claims — COMPLETE — ES256 + JWKS + rotation; demo server verifies
Short-lived signed JWT (ES256, key in SecretStore, JWKS at `/.well-known/jwks.json`) with minimal claims (sub, conversation, agent, scopes, iat/exp, jti); attached only for connections marked trusted; rotation.
- Tests: claim contents minimal; expiry; signature verifiable via JWKS.

### E5.7 Tool execution & audit — COMPLETE
Timeouts, retries only for idempotent/read tools, idempotency keys for writes where supported, sanitized args/results (secret redaction), latency, correlation IDs; human tool actions from the workspace.

### E5.8 Demo MCP server — COMPLETE
`examples/mcp-bank-demo`: standalone external "Meridian core" MCP server (read: accounts/transactions/schedule; write: raise dispute; sensitive: reverse transaction) with bearer and OAuth modes, for Compose demo profile and tests. Not part of OCSO core.

**P5 exit:** admin connects demo server via OAuth, approves tools; Maya reads data, raises a write, and a sensitive reversal requires human confirmation.

---

## P6 — WhatsApp & channel behavior

### E6.1 Channel adapter contract — COMPLETE
`ChannelAdapter` (verify, parse inbound envelopes incl. statuses, fetch media, render, send, capabilities, limits); channel registry; channel admin UI (`design/04` Channels tab) with secrets by reference.

### E6.2 WhatsApp Cloud API adapter — COMPLETE — adapter, webhooks, channel setup UI (verify-token handshake e2e); live verification needs a Meta number
Per ADR-007: direct Cloud API implementation (Graph API version configurable), GET challenge, `X-Hub-Signature-256` over raw body (constant-time), inbound text/image/audio/video/document/location/contacts/interactive/reaction normalization, BSUID/phone identity, media two-step download to BlobStore (host allowlist, size caps, MIME validation), delivery statuses sent/delivered/read/failed, 24-hour window + template fallback, error-code mapping, rate limits.
- Tests (required): signature verification; duplicate wamid ignored; each message type fixture; status callbacks update delivery state; media download safety.

### E6.3 Rendering policy — COMPLETE
Channel renderers emit only customer-safe content (no tool traces/internal notes/policy metadata); WhatsApp formatting and chunking; capability-driven media/structured rendering.
- Tests: internal events never rendered to customer channels.

### E6.4 Outbound delivery — COMPLETE
Delivery jobs with retry/backoff, recorded provider message IDs, failure surfacing to CS UI and alerts.

**P6 exit:** production-style WhatsApp agent (live verification needs Meta credentials).

---

## P7 — Human operations

### E7.1 Queues, teams, routing — COMPLETE — API + /queues page
Queues (mode AUTO_ASSIGN | OPEN_PICKUP, pickup-then-auto-assign delay, strategy, skills, languages), teams, membership, exec availability + capacity; UI for CS Lead (Routing tab, Queues, Team).

### E7.2 Escalation rules — COMPLETE — API + escalation rules on the agent screen
Triggers: customer request, agent decision (tool), keyword/intent, policy/risk, repeated tool failure, SLA, low-confidence (where configured), business conditions; per-agent + global rules; target queue + priority + mode; fired counts. UI: Escalation tab.

### E7.3 Handoff lifecycle — COMPLETE — backend + workspace (e2e)
Handoff records (reason, trigger, requested/assigned/accepted/returned/resolved timestamps, summary); ESCALATION_REQUESTED → WAITING_FOR_HUMAN routing; customer-facing handoff message via channel.

### E7.4 Assignment — COMPLETE — backend (claim race test) + workspace pickup (e2e)
Pure assignment strategy (eligibility: team, availability, capacity, skills, language, account owner; ranking: least active workload then longest idle); auto-assign with accept + timeout reassignment; open pickup claim (atomic); transfer; unassign.
- Tests (required): assignment/pickup races (two execs claim → exactly one wins); strategy ranking.

### E7.5 Human takeover & replies — COMPLETE — take over, replies with verified attachments, notes (e2e)
Take over from AI_ACTIVE; HUMAN_ACTIVE blocks autonomous AI replies (runtime guard + worker check); human replies via channel; internal notes (separate table, never rendered to customers); human tool actions.
- Tests (required): human takeover; AI never sends while HUMAN_ACTIVE (including in-flight turn at takeover time).

### E7.6 Return to AI — COMPLETE — return to AI with handover summary, cancel (e2e)
AI_RESUMING with editable handover summary + selected notes passed to agent; resume on next customer message (or immediate follow-up if configured); cancel return; same agent, full context.
- Tests (required): return-to-AI resumes with handover context; cancel return.

### E7.7 Resolve / reopen / dispositions / tags — COMPLETE — resolve with disposition, reopen (tags UI not built; API stores tags)

### E7.8 SLA engine — COMPLETE — pickup and resolution SLA deadlines, timers, /sla page, breach alert conditions
SLA policies (first human response, pickup by priority, resolution by type); due timestamps; ok/risk/breach state; breach events; business alerts.

### E7.9 AI copilot — COMPLETE — on-demand + proactive drafts, insert/rewrite in the workspace (e2e)
Draft suggestions for the human (never auto-sent), rewrite shorter, insert into composer; usage accounted as COPILOT.

### E7.10 Workspace UI completion — COMPLETE
Views all / assigned to me / waiting for human / AI active / priority / resolved; claim, take over, return, resolve, reopen, transfer; composer modes reply/note/tool action; context rail (customer, accounts via approved tools, AI summary, assignment, approved tools, recent actions, tags); pickup queue page.

### E7.11 Team-scoped virtual-agent ownership — COMPLETE — ADR-026; agents owned by teams, leads manage their teams' agents only
`agent_teams` + migration `0016_agent_team_ownership` (backfill from default-queue teams); scopes and owner rules in `@ocso/application` (`agents/access.ts`, `agents/owners.ts`) applied to agents, prompts, escalation rules, tool grants, analytics, quality, alerts, customers, conversations (`conversations.read_team` replaces `read_all`) and the realtime filter; `PUT /v1/agents/:id/owners` (Tech Admin `agents.assign_owner`, leads within their teams); web owning-team picker, Settings → Owning teams card, no-team empty state; demo seed with two leads.
- Tests: application ownership + scope suites, API 404/owners/realtime suite, migration backfill, Ask OCSO tool scope, web unit (owner rules), agents e2e with a second lead.

**P7 exit:** full AI → human → AI lifecycle through the UI.

---

## P8 — Observability, analytics & alerts

### E8.1 OpenTelemetry — COMPLETE
Traces for HTTP, turn, model request, tool call, queue job, alert evaluation; metrics (turn latency, TTFT, tokens, cache, queue depth/age, leases, provider errors, tool latency); log correlation; OTLP export configurable; trace IDs stored on turns/usage/tool calls for pivoting.

### E8.2 Telemetry read models — COMPLETE — telemetry, analytics, home, quality services and APIs with tests
Postgres-backed aggregates for in-product dashboards (usage_events, turns, tool_calls, health samples, worker stats, queue stats) with time-bucket queries/rollups; uptime from health samples.

### E8.3 Tech Admin system control center — COMPLETE — /system, workers (scaling status), queues, telemetry (e2e)
`design/03`: status bar, service health, uptime, tiles, latency chart, token + cache usage by profile, worker instances + config editor, provider health cards, MCP health table; Queues & leases page; Telemetry page (tokens/cache/cost by agent/profile/provider, provider failure/retry/timeout, traces links, logs links).

### E8.4 CS Lead analytics — COMPLETE — /analytics, agent analytics, escalation reasons (e2e)
Agent overview (`design/02` Overview + Analytics tabs): conversations, containment, escalation rate, resolution, first response, SLA breaches, tool failure rate, CSAT; escalation reasons; failure topics; knowledge gaps; prompt-correction opportunities; channel breakdown; handling time; sales/service outcomes. Conversation insights job (explicit, auditable classifier output per conversation: topic, outcome, escalation reason, knowledge gap question). No opaque "quality score".

### E8.5 QA reviews & prompt corrections — COMPLETE — reviews and corrections pages + agent Quality tab (e2e)
Conversation reviews (reviewer, outcome tag, score with explicit rubric, notes); prompt correction workflow (source turn → observed → desired → component → staged into draft → new version → optional replay evaluation → activation).

### E8.6 Replay evaluation — COMPLETE — replay evaluation job + prompt-tab replay
Run a draft prompt version against selected historical customer turns (no side effects: tools stubbed/read-only), side-by-side results, summary counts; used before activation.

### E8.7 CS Exec operational indicators — COMPLETE — exec home from /v1/home
Home + workspace: assigned, pickup queue, waiting time, SLA state, handoff status, workload.

### E8.8 Alert engine — COMPLETE — engine, 18 conditions (spend_budget_above via E4.7), alerts pages (e2e)
Rules (technical/business, platform-wide or agent-specific, condition + window, severity, audience roles, destinations, dedupe window, auto-resolve); evaluator registry (workers below min, queue age, provider failure spike, MCP down, latency SLO, token/cost spike, auth failures, DB degraded, escalation spike, SLA breaches, repeated failure intent, agent quality signal, tool/business failures, conversion anomaly); leader-elected scheduler; lifecycle OPEN → ACKNOWLEDGED → RESOLVED; audit.
- Tests (required): each evaluator; dedupe/window; auto-resolve; audience filtering.

### E8.9 Alert delivery adapters — COMPLETE — in-app, email, Slack, Teams, webhook (signed), PagerDuty
In-app (+ SSE), email (SMTP), Slack, Microsoft Teams, generic webhook (HMAC-signed), PagerDuty Events v2; retries; delivery status. UI: alerts list, rules, destinations.

### E8.10 Outbound event webhooks — COMPLETE — signed outbound webhooks, relay, retries, UI
Subscriptions (URL, events, signing secret), delivery log, retries (`design/04` Webhooks tab).

**P8 exit:** role-appropriate visibility; alerts open, deliver, ack and resolve.

---

## P9 — Internal OCSO agent

### E9.1 Internal tool catalogue — COMPLETE
Tools wrap existing application services (no direct DB access); each declares permission + risk (READ / LOW_WRITE / HIGH_WRITE); catalogue filtered by the user's permissions before the model sees it; re-authorized on execution.

### E9.2 Agent loop & streaming — COMPLETE
`internal-agent` model profile; cited answers (links to OCSO objects), inline tables, cards; AI SDK UI streaming to the drawer; session history persisted per user.

### E9.3 Confirmation & audit — COMPLETE
HIGH_WRITE (and configurable LOW_WRITE) create pending actions that require an explicit UI confirmation click; all actions audited as `via=INTERNAL_AGENT` attributed to the human.

### E9.4 Drawer + full page UI — COMPLETE — Ask OCSO drawer with streaming, threads, confirm/reject (e2e)
`design/05`: ⌘J drawer on every screen, role-aware suggestions, context of the current screen, RBAC refusals explained.
- Tests (required): internal agent permissions (exec cannot reach admin tools; lead cannot read infra telemetry; confirmation required for sensitive writes; audit written).

**P9 exit:** example questions from docs/12 answered with the right data per role.

---

## P10 — Scaling & AWS production

### E10.1 Leases & recovery hardening — COMPLETE — fencing, reaper releases lost workers’ jobs, chaos test (crash + drain)
Lease acquire/heartbeat/transfer/expiry with fencing (lease_version checked on every customer-visible write); slot accounting; recovery sweeper; drain.
- Tests (required): worker killed mid-turn → another worker recovers from Postgres, no duplicate customer reply; stale-lease writes rejected.

### E10.2 SQS queue adapter — COMPLETE
FIFO with MessageGroupId = conversation, dedup IDs, long polling, visibility extension heartbeat, DLQ; passes the queue contract suite (against ElasticMQ/LocalStack in tests).

### E10.3 S3 blob store + Secrets Manager secret store — COMPLETE
S3 (SSE-KMS, presigned URLs), Secrets Manager (create/put/get with caching); contract suites shared with local drivers.

### E10.4 Deployment adapter & autoscaling — COMPLETE — ECS/Compose deployment adapter, metrics, task protection, apply status
`DeploymentAdapter`: Compose (advisory) and ECS (register scalable target min/max, target tracking on published slot-utilization metric, step scaling on queue age, cooldowns, task scale-in protection while holding leases); leader publishes CloudWatch metrics; Tech Admin worker config applies through it.

### E10.5 Terraform for ECS Fargate — COMPLETE — 13 modules, validate/fmt in CI; not yet applied to a real account
VPC, ALB (path routing web/api), ECS cluster, web/api/worker services, migration task, RDS PostgreSQL, SQS + DLQ, S3, Secrets Manager, KMS, CloudWatch logs, OTel collector sidecar, IAM, ECR; `terraform validate` in CI (containerized).

### E10.6 Load & chaos tests — COMPLETE — tests/resilience chaos + load scripts; results in docs/operations/resilience-testing.md
Load script (web-chat channel, mock model with latency) measuring turn latency and slot utilization; chaos: kill workers during load; report in `docs/benchmarks`.

**P10 exit:** horizontal scaling with conversation continuity demonstrated.

---

## P11 — Hardening & release

| ID | Task | Status |
|---|---|---|
| T11.1 | Playwright e2e for every "definition of complete" capability | COMPLETE — 10 Playwright specs, 63 tests, all passing on the production build (see PM/DEFINITION-OF-COMPLETE.md) |
| T11.2 | Security review: SSRF, authz coverage, secret redaction, webhook replay, CSRF, session security | IN PROGRESS — done: CSRF same-origin guard, per-address sign-in throttle, staff attachment scoping, health endpoint exposure, SSRF guards reviewed, log redaction; see docs/15 notes |
| T11.3 | Data retention jobs (conversations, media, logs, tool payloads; audit separate) | COMPLETE — retention per class, hourly worker job, audit floor in the database |
| T11.4 | Operator docs: Compose runbook, AWS runbook, backup/restore, upgrades, provider/channel/MCP setup guides | COMPLETE — compose.md, aws.md, worker-scaling.md, resilience-testing.md, setup-guide.md |
| T11.5 | Docs sync: update `docs/*` where implementation refined the spec (per build rule §24) | COMPLETE — implementation notes in docs/05, 07, 08, 09, 10, 15 |

### E11.6 Authentication hardening on Better Auth (ADR-025) — COMPLETE — Better Auth 1.7.5 replaces the hand-built sessions; OCSO keeps authorization
| ID | Task | Status |
|---|---|---|
| T11.6.1 | Better Auth server in `@ocso/application/auth-server` (Drizzle adapter on `users` + `auth_*` tables, OCSO scrypt, bearer, twoFactor, passkey, sso, OCSO policy plugin); mounted at `/api/auth` before body parsers; HTTP allowlist pinned by `auth-surface.test.ts` | COMPLETE |
| T11.6.2 | Migrations 0014/0015: credential accounts from `password_hash`, lower-case emails, drop `sessions`; `login_attempts` kept | COMPLETE |
| T11.6.3 | Guard on Better Auth sessions (Bearer from the BFF), idle + absolute expiry, "require MFA for roles", stream re-validation (realtime SSE, Ask OCSO) | COMPLETE — auth-sessions / auth-mfa int tests |
| T11.6.4 | Invites (72 h link, resend, log-driver link hand-over), admin reset links, forgot/reset/change password, break-glass rule + `OCSO_RECOVERY_TOKEN` recovery | COMPLETE |
| T11.6.5 | TOTP + backup codes, passkeys, SSO (OIDC + SAML) with domain-bound provisioning (link invited users; auto-provision opt-in) | COMPLETE — OIDC flow tested end to end against a local IdP; SAML and passkey ceremonies not e2e-tested (need a real IdP / virtual authenticator) |
| T11.6.6 | Web: sign-in (password → code, passkey, SSO), forgot/reset/invite/recover pages, forced MFA enrolment, Account security, Settings → Sign-in security, Team invites | COMPLETE — auth-and-roles.spec.ts (invite, MFA, forgot password), proxy.spec.ts |
| T11.6.7 | Rate limiting in the database keyed by the web tier's client address; audit of every auth event | COMPLETE |
| T11.6.8 | Compose (keygen `better_auth_secret`, entrypoint, env), docs (15, setup guide, compose, aws) | COMPLETE — Terraform wiring of `BETTER_AUTH_SECRET` open (aws.md §10) |

### E11.7 The plugin boundary (ADR-028) — COMPLETE — "the plugin boundary is the product"
| ID | Task | Status |
|---|---|---|
| T11.7.1 | Open kinds validated by registries (channels, model providers, alert destinations); DB kind columns stay `text` | COMPLETE |
| T11.7.2 | Self-describing plugins: channel descriptor (mark, identity, setup steps, embed hook, templates, displayIdentity), provider definition (mark, caching, catalog mapping, baseModel, devOnly), alert adapter (events, JSON Schema form, summary); web renders from `/kinds` | COMPLETE |
| T11.7.3 | Message templates as a channel capability (migration 0019 renames the table; `/whatsapp-templates` → 308 `/templates`) | COMPLETE |
| T11.7.4 | Built-in tools through the same authorization + `tool_calls` audit path as MCP (security fix) | COMPLETE — builtin-tools.int.test.ts |
| T11.7.5 | Channel egress through the SSRF guard (`NO_NETWORK` default) | COMPLETE |
| T11.7.6 | Driver registries (email, blob, secrets, queue, deployment); one composition root (`OcsoPlugin`, `FIRST_PARTY_PLUGINS`) for api and worker | COMPLETE |
| T11.7.7 | `pnpm lint` plugin-boundary guard derived from the plugins | COMPLETE — 0 violations, 0 escapes |
| T11.7.8 | `@winsendotai/ocso-plugin-sdk` (versioned contracts + config-driven loader) | NOT STARTED — next, after v1 |

---

## Required test coverage (from the build brief)

| Test area | Task(s) | Status |
|---|---|---|
| RBAC | T1.5.3, T1.5.4 | COMPLETE — packages/auth/test/rbac.test.ts, apps/api/test/unit/route-access.test.ts, apps/api/test/int/{auth,alerts,security}.int.test.ts, apps/web/e2e/auth-and-roles.spec.ts |
| Conversation state machine | T2.1.1 | COMPLETE — packages/domain/test/transitions.test.ts |
| Worker leases / recovery | E10.1, E2.7 | COMPLETE — packages/agent-runtime/test/runtime.int.test.ts (race, fencing, drain, recovery), packages/queue/test/pg-queue.int.test.ts |
| Duplicate webhook handling | E2.5, E6.2 | COMPLETE — packages/application/test/spine.int.test.ts, packages/channels/test/whatsapp-inbound.test.ts, apps/api/test/int/conversation-flow.int.test.ts |
| Prompt compilation | E3.3 | COMPLETE — packages/prompt-compiler/test/compile.test.ts |
| Prompt versioning | E3.4 | COMPLETE — packages/application/test/prompt-versions.int.test.ts, packages/db/test/migrations.int.test.ts |
| Prompt-cache invalidation | E4.2, E4.5 | COMPLETE — packages/model-providers/test/contract (per-provider cache params), prompt-compiler prefix-hash tests |
| Turn-cache invalidation | E4.5 | COMPLETE — packages/agent-runtime/test/runtime.int.test.ts (HOT/COLD on activation) |
| Provider adapter contracts | E3.1, E4.1 | COMPLETE — packages/model-providers/test/contract |
| Provider fallback policy | E4.4 | COMPLETE — packages/model-providers/test/fallback-policy.test.ts |
| MCP authorization | E5.4 | COMPLETE — packages/tools/test/authorizer.test.ts, packages/application/test/mcp-*.int.test.ts, apps/api/test/int/mcp*.int.test.ts |
| Sensitive tool confirmation | E5.5 | COMPLETE — packages/agent-runtime/test/human-tools.int.test.ts, runtime.int.test.ts |
| Human takeover | E7.5 | COMPLETE — packages/application/test/spine.int.test.ts, runtime.int.test.ts (supersession) |
| Return-to-AI | E7.6 | COMPLETE — spine.int.test.ts, runtime.int.test.ts (handover), apps/api/test/int/conversation-flow.int.test.ts |
| Assignment / pickup | E7.4 | COMPLETE — packages/domain/test/routing-and-sla.test.ts, spine.int.test.ts (claim race) |
| Alert rules | E8.8 | COMPLETE — packages/application/test/alerts-*.int.test.ts, packages/alerts/test/* |
| Internal agent permissions | E9.1–E9.3 | COMPLETE — packages/internal-agent/test/internal-agent.int.test.ts |

## Definition of complete — traceability

| Operator capability | Delivered by | Status |
|---|---|---|
| Deploy with Docker Compose | E1.7 | COMPLETE |
| Log in as each user type | E1.5, E1.6 | COMPLETE |
| Create/configure a named virtual agent | E2.3, E3.4, E7.1, E7.2 | COMPLETE |
| Configure a supported model provider | E4.1 | COMPLETE (live provider calls need credentials) |
| Create logical model profiles | E4.3 | COMPLETE |
| Version and activate prompts | E3.4 | COMPLETE |
| Connect an MCP tool server | E5.1 | COMPLETE |
| Connect a customer channel | E2.8, E6.1, E6.2 | COMPLETE (WhatsApp live check needs a Meta number) |
| Persistent customer conversation | E2.5–E2.8 | COMPLETE |
| Receive multimodal content | E2.1, E2.9, E6.2 | COMPLETE |
| Call external tools safely | E5.4–E5.7 | COMPLETE |
| Escalate to a human | E7.2, E7.3 | COMPLETE |
| Auto-assign or open-pickup | E7.4 | COMPLETE |
| CS Exec replies | E7.5 | COMPLETE |
| Return conversation to AI | E7.6 | COMPLETE |
| Recover after worker failure | E10.1 | COMPLETE — chaos test |
| Technical observability | E8.1–E8.3 | COMPLETE |
| Business observability | E8.4–E8.7 | COMPLETE |
| Receive alerts | E8.8, E8.9 | COMPLETE |
| Use the internal OCSO agent | P9 | COMPLETE |
| Prompt/cache/token telemetry | E3.7, E4.2, E4.5, E8.3 | COMPLETE (real hit rates need real providers) |
| Deploy the same architecture to ECS Fargate | E10.2–E10.5 | IN PROGRESS — Terraform + adapter done; needs an AWS account to apply |

## Change log

| Date | Change |
|---|---|
| 2026-09-22 | Plan created from full read of README, docs/00–99 and design/*. Provider caching split into one task per provider (E4.2). |
| 2026-09-22 | Status sync: foundation, runtime, providers, MCP manager, alerts, internal agent backend, human tools/confirmation, copilot backend, customer claims landed with tests; UI screens, telemetry/analytics, Compose, Terraform and scaling adapter in progress. |
| 2026-09-22 | Status sync after UI screens, scaling adapter, retention, claims, webhooks, resilience tests and operator docs landed. |
| 2026-09-22 | All screens landed; full e2e (63 tests), integration (270+) and unit (890) suites green; chaos test passes on the final build. |
| 2026-09-22 | E7.11 team-scoped virtual-agent ownership (ADR-026): agents owned by teams; lead scope for agents, conversations, analytics, quality and alerts; Tech Admin owner reassignment. |
| 2026-09-22 | E4.7 model discovery, open-source catalog prices and the monthly spend budget alert (ADR-027, PM/research/09); migration 0017. |
| 2026-09-22 | E11.7 plugin boundary (ADR-028): open kinds, self-describing plugins, message templates as a capability (migration 0019), built-in tools authorized and audited, guarded channel egress, driver registries, one composition root, lint guard. Demo fixes: partial PATCH defaults, no-agent routing, agent history cut-off. |
