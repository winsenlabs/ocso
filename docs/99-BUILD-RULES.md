# Build Rules — Mandatory

This is the final authority for implementation behavior unless a newer explicit architecture decision record supersedes a specific rule.

## 1. Use the latest stable stack

At implementation time, use the **latest stable compatible releases** of the chosen frameworks, SDKs and libraries.

Primary stack:
- TypeScript
- NestJS backend
- Next.js frontend
- PostgreSQL
- Vercel AI SDK
- Vercel Chat SDK where appropriate
- Docker / Docker Compose
- ECS Fargate for scaled AWS deployment

Do not copy old tutorials or adopt deprecated APIs simply because an example exists. Check current upstream documentation before integrating provider-specific APIs.

Lock actual resolved dependencies in the package manager lockfile.

## 2. No large monolith files

**Do not create giant source files.**

This is a hard architectural rule.

Avoid:
- 1,000-line services
- giant controllers
- single files containing the entire agent runtime
- one universal "utils.ts"
- one universal "types.ts"
- giant React pages with all UI logic inline
- huge switch statements for every provider/channel/tool

Prefer small cohesive modules with explicit contracts.

Guideline, not a blind numeric law:
- aim for source files generally under ~300 lines
- files approaching ~400-500 lines require an explicit reason or decomposition
- split by responsibility, not arbitrary line count

Tests and generated/migration/schema files may reasonably differ, but generated files must not become places for hand-written business logic.

## 3. Single tenant, multi user

OCSO is **single-tenant only**.

One deployment = one organization.

It is **multi-user**, with the product role presets (ADR-029; formerly Platform Tech Admin, CS Lead, CS Exec):
- Tech
- Head
- Lead
- Service

Do not:
- add tenant switching
- add tenant-aware request middleware
- add tenant_id to every table
- build cross-tenant admin
- prematurely generalize the codebase into SaaS tenancy

Separate organizations should run separate OCSO deployments.

## 4. Plugins/adapters at external boundaries

Models, channels, tools, queues, storage and telemetry destinations must use clean interfaces.

Do not scatter provider-specific conditionals throughout domain logic.

External implementations belong behind adapters.

## 5. PostgreSQL is durable truth

Worker memory, Redis/cache and provider-native conversation state are not the authoritative record.

Persist business-critical state before relying on asynchronous execution.

The system must recover conversations after worker/container loss.

## 6. Virtual agent is not worker

A virtual agent is a named logical AI employee.

A worker is infrastructure capacity.

Never model them as the same entity or bind one virtual agent permanently to one container.

## 7. Human takeover must be first-class

AI owns the conversation by default, but human intervention is a core workflow, not a later plugin.

Support:
- escalation
- waiting state
- pickup or auto-assignment
- human-active state
- return-to-AI
- audit trail

## 8. Multimodal from the domain layer

Do not design the database/API as text-only and plan to retrofit media later.

Use canonical interactions with multiple typed parts.

## 9. Prompt compiler, not prompt blob

Runtime prompts are assembled from explicit versioned components.

Keep stable prefixes stable to maximize provider prompt caching.

Prompt changes are versioned and auditable.

## 10. Prompt and turn caching are required

Implement:
- provider prompt-cache support/metrics when the provider supports it
- OCSO application-level context/turn caching

Caches are derived state and must be safely invalidatable.

## 11. Model provider neutrality

The application must support provider adapters for:
- AWS Bedrock
- Google Vertex AI
- Microsoft Foundry
- OpenAI API
- Anthropic API
- Sarvam API

Virtual agents should use logical model profiles rather than embed provider-specific IDs throughout the product.

## 12. Vercel AI SDK is an implementation dependency, not the domain model

Use it for generation/streaming/tool-call primitives.

Do not couple conversation, RBAC, handoff, alerting, persistence or business state to SDK-specific objects.

## 13. MCP servers remain external

OCSO may manage/authenticate connections to MCP servers but does not absorb external business systems into the core codebase.

Business applications remain separate services.

## 14. Authorization in code, never only in prompts

The model cannot grant itself permissions.

Every tool/control action passes deterministic server-side authorization.

The internal OCSO agent follows the same rule.

## 15. Role-specific observability

Do not expose the same telemetry surface to everyone.

- Tech: infrastructure, tokens, provider/tool health, cache, latency, uptime
- Head and Lead: agent/business performance, prompt corrections, escalation/SLA/outcomes
- Service: conversations, queue, priority and assigned workload

## 16. Alerts are first-class

Alerts have:
- rule
- condition/window
- severity
- audience
- delivery
- lifecycle: open/acknowledged/resolved
- correlation to underlying telemetry/conversations where possible

## 17. Same application, two deployment shapes

The core application must run:
- on one EC2 with Docker Compose
- on ECS Fargate with managed AWS dependencies

Do not create two product codepaths.

## 18. API/worker separation

API/control workloads and agent workers are independently scalable logical processes.

They may share packages and even a container image, but do not merge execution responsibilities into a single giant process architecture.

## 19. Explicit contracts and validation

Use typed DTOs/schemas at:
- HTTP boundaries
- event boundaries
- channel boundaries
- provider boundaries
- MCP/tool boundaries
- configuration boundaries

Validate external input.

## 20. Idempotency and audit

Inbound channel webhooks and side-effecting operations must account for retries/duplicates.

Privileged configuration and business side effects must be auditable.

## 21. Never log secrets

No secrets in:
- logs
- traces
- prompts
- tool-call audit payloads
- browser responses
- committed configuration

## 22. Build vertical slices

Prefer end-to-end working slices over months of abstraction-only development.

Every slice should include persistence, auth, API, UI where relevant, tests and observability.

## 23. Tests are part of the feature

At minimum add meaningful tests for:
- domain behavior
- permission boundaries
- adapter contracts
- failure/retry behavior
- conversation concurrency/idempotency
- prompt compiler/caching invalidation
- human handoff
- tool authorization

## 24. Do not silently change architecture

If implementation reveals a necessary architecture change:
1. document it
2. explain the tradeoff
3. update affected docs
4. preserve the product invariants above

Do not let incidental code become the new architecture by accident.
