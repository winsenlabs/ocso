# API and Event Contracts

## 1. API style

NestJS exposes control/operations APIs consumed by Next.js and external channel/webhook handlers.

Use explicit DTO/schema validation and version boundaries.

## 2. API areas

Suggested modules/routes:
- auth/session
- users
- virtual agents
- prompt versions
- model profiles/providers
- channels
- customers
- conversations
- interactions
- queues
- assignments
- handoffs
- MCP connections/tools
- alerts
- analytics
- telemetry summaries
- system/worker configuration
- internal-agent tools

## 3. Realtime

Use WebSocket or SSE for CS/admin live updates.

Possible stream events:
- conversation.created
- interaction.received
- agent.status
- agent.response_delta
- handoff.requested
- assignment.changed
- alert.opened
- alert.updated
- conversation.resolved

The canonical backend event is separate from how a specific UI renders it.

## 4. Event envelope

Conceptually:
```ts
interface OCSOEvent<T> {
  id: string;
  type: string;
  version: number;
  occurredAt: string;
  correlationId: string;
  conversationId?: string;
  agentId?: string;
  payload: T;
}
```

Events used for reliable processing should include idempotency/deduplication semantics.

## 5. Error contracts

Normalize errors into categories:
- validation
- authentication
- authorization
- not found
- conflict
- provider unavailable
- provider rate limited
- tool unavailable
- tool rejected
- timeout
- policy denied
- capacity/backpressure
- internal

Do not return raw provider exceptions to customer-facing clients.

## 6. Compatibility

Version public/external contracts deliberately. Internal package interfaces may evolve faster but must preserve module boundaries and tests.
