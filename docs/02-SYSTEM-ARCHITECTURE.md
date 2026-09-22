# System Architecture

## 1. Architectural shape

OCSO has three logical planes inside one product.

### Conversation Plane
- inbound channel adapters
- identity resolution
- canonical interactions
- virtual-agent runtime
- prompt compilation
- model execution
- tool/MCP calls
- conversation state
- human handoff

### Operations Plane
- CS inbox
- queue/pickup
- assignment
- human replies
- internal notes
- QA
- agent performance
- business analytics

### Control Plane
- users/RBAC
- virtual-agent configuration
- model providers
- channels
- MCP connections
- worker/scaling configuration
- telemetry
- alerts
- infrastructure settings

The internal OCSO agent is an alternative permissioned interface over the control and operations APIs.

## 2. Repository/service shape

Prefer a monorepo with deployable apps and shared packages, for example:

```
apps/
  api/          # NestJS HTTP/control plane
  worker/       # NestJS worker process
  web/          # Next.js UI
packages/
  domain/
  db/
  agent-runtime/
  prompt-compiler/
  model-providers/
  channels/
  mcp/
  auth/
  events/
  observability/
  ui/
infra/
  compose/
  aws/
docs/
```

Do not implement the whole backend in one NestJS module and do not create giant "service.ts" files. Boundaries matter.

## 3. Runtime topology

```
Customers
   |
Channel provider/webhook
   |
NestJS API / ingress
   |
Identity + conversation router
   |
Reliable event/job layer
   |
Worker pool
   |
Agent Runtime -- Model Adapter
   |
   +-- MCP / Tool Servers
   |
PostgreSQL

Next.js UI <--> NestJS Control/Operations APIs
```

Object/media payloads should be stored in S3-compatible storage; PostgreSQL stores metadata and references.

## 4. Stateless vs stateful responsibilities

PostgreSQL is the durable source of truth.

Workers may hold temporary hot state, compiled context and active-conversation leases. A worker crash must not lose the conversation.

No conversation's durable correctness may depend on in-memory state.

## 5. Adapter boundaries

OCSO should own contracts for:
- `ModelProvider`
- `ChannelAdapter`
- `ToolProvider`
- `QueueAdapter`
- `BlobStore`
- `TelemetrySink`
- `SecretStore`

Concrete infrastructure implementations plug into these contracts.

## 6. Deployment independence

The business logic must not know whether it is running on:
- one EC2 host via Docker Compose
- ECS Fargate
- another compatible container runtime

Infrastructure concerns are selected by configuration/adapters.

## 7. API and worker split

Keep API/control and worker concerns logically separate even if they share one codebase and container image.

API:
- webhooks
- auth
- REST/RPC endpoints
- WebSocket/SSE
- UI APIs
- admin configuration
- conversation reads/actions

Worker:
- active conversation execution
- prompt compilation
- model calls
- tool loops
- retries
- summarization
- handoff triggers

This allows independent scaling on ECS.

## 8. Internal event model

Important internal events should be explicit and versioned:
- interaction.received
- conversation.created
- conversation.assigned_worker
- agent.turn_started
- model.request_started
- model.request_completed
- tool.started
- tool.completed
- tool.failed
- agent.response_delta
- agent.turn_completed
- handoff.requested
- handoff.assigned
- human.message_sent
- ai.resumed
- conversation.resolved
- alert.opened
- alert.resolved

These events power UI streaming, audit, telemetry and alerts.
