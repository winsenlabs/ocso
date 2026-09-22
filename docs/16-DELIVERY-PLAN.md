# Delivery Plan

This plan is intentionally phased so a coding agent or team can build vertically rather than creating every abstraction before a usable conversation exists.

## Phase 0 — Foundation
- monorepo/workspace
- NestJS API app
- NestJS worker app
- Next.js app
- PostgreSQL and migrations
- Docker Compose
- shared config/logging/error packages
- health endpoints
- basic authentication/RBAC skeleton

Exit: `docker compose up` yields healthy web/api/worker/db.

## Phase 1 — Conversation spine
- users/roles
- virtual agents
- customers/customer identities
- conversations/interactions
- canonical multimodal part model
- web chat test channel
- persistent conversation UI
- simple worker dispatch

Exit: customer can hold a persistent text conversation with a named agent.

## Phase 2 — Agent runtime
- Vercel AI SDK integration
- model provider contract
- first provider
- streaming
- tool loop contract
- usage events
- prompt compiler
- prompt versioning
- rolling summary/context compaction

Exit: robust persistent streamed agent turns.

## Phase 3 — Provider fleet and caching
- Bedrock
- Vertex
- Microsoft Foundry
- OpenAI
- Anthropic
- Sarvam
- logical model profiles
- provider fallback policy
- prompt-cache controls/metrics
- turn/context caching

Exit: provider can be configured without changing agent code.

## Phase 4 — MCP and tools
- MCP client/connection manager
- shared connection
- OAuth flow
- discovery/schema sync
- permissions
- JWT/customer claim support
- user-scoped connections
- tool audit

Exit: agent safely performs real external capabilities.

## Phase 5 — WhatsApp and production channel behavior
- WhatsApp webhook verification
- phone/customer identity
- media
- outbound replies
- delivery events
- idempotency
- channel rendering policy

Exit: production-style WhatsApp agent.

## Phase 6 — Human operations
- CS inbox
- all/open/assigned views
- queues
- open pickup
- auto-assignment
- takeover
- human replies
- internal notes
- return-to-AI
- SLA foundation

Exit: full AI-to-human-to-AI lifecycle.

## Phase 7 — Observability and alerts
- OpenTelemetry instrumentation
- Tech Admin telemetry
- CS Lead metrics
- CS Exec operational indicators
- alert engine
- severity/audience
- in-app alerts
- external alert adapters

Exit: role-appropriate operational visibility.

## Phase 8 — Internal OCSO agent
- permissioned internal tools
- operational Q&A
- alert investigation
- conversation/business analysis
- controlled write actions
- audit and confirmation policy

Exit: platform can be navigated conversationally.

## Phase 9 — Scaling and AWS production
- queue abstraction hardened
- conversation leases
- recovery
- ECS Fargate API/worker services
- RDS/S3/SQS/Secrets Manager adapters
- autoscaling
- worker config panel
- load tests
- chaos/recovery tests

Exit: horizontal scaling with conversation continuity.

## Definition of done for each feature

Every feature includes:
- domain/API behavior
- authorization
- error behavior
- database migration where required
- unit tests
- integration tests
- observability
- docs update
- no oversized monolithic files
