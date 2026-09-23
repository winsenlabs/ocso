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

*As built — approvals (PM/research/11 §4, ADR-030):* approvable write endpoints accept `approval:
{checkerId, reason}` (or `{bootstrap: true, reason?}` when nobody else could check it). A draft object is
written directly (as before). When the write needs approval they answer **409 `approval_required`** with
`details: {objectKind, objectId, action}` without `approval`, and **202 `{proposal}`** with it; an object
with an open proposal answers **409 `approval_open`** (`details.proposalId`). Wave 1 wires `PATCH
/v1/agents/:id`, `POST /v1/agents/:id/status {LIVE}` (PAUSED stays immediate, `agents.pause`), `DELETE
/v1/agents/:id` (`agents.delete`, always a proposal) and `POST
/v1/agents/:agentId/prompt/versions/:id/activate` (a proposal once the agent is approved). The queue is
`/v1/approvals`: `GET /` (`box=AWAITING_ME|SENT_BY_ME|OPEN|DECIDED`, keyset `before`+`beforeId`),
`GET /counts`, `GET /kinds`, `GET /checkers?objectKind&objectId`, `GET /state?objectKind&objectId`,
`GET /:id`, `GET /:id/checkers`, `POST /` (kinds without their own write endpoint), `PATCH /:id` (maker
edits: revision+1; also how a maker refreshes a proposal whose dependencies changed), `POST /:id/withdraw`,
`POST /:id/decision {decision, reason, contentHash, dependencyHash?}` (approve: 409 `content_changed`,
409 `dependency_changed` against the dependency hash stored at submit; reject never needs matching hashes;
403 `self_review`/`not_checker`/`checker_invalid`), `POST /bulk-decision` (approve only, ≤ 50, per-item
outcome), `POST /:id/checker` (reassign), `POST /:id/void {reason}` (`approvals.reassign_any`: closes an
open proposal nobody can decide, audited). An ineligible checker is 400 `checker_not_eligible`; an UPDATE
that changes nothing is 400 `no_changes`. `GET /checkers` needs a make permission for the kind and write
scope on the object; candidates carry `email`/`role` only for callers with `users.read`. Proposing is
write-scoped like the direct write (an agent: an owning team's member), so `agents.read_all` alone never
lets someone propose. While an agent or any of its prompt versions has an open proposal, the agent's
owners, tool grants and escalation rules answer 409 `approval_open` too.

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

*As built:* `approval.requested`, `approval.decided` and `approval.checker_invalid` reach the maker, the
named checker and holders of `approvals.reassign_any` only; the web app shows them as notices and
re-reads the approvals screen.

*As built:* SSE only (no WebSocket endpoint). Staff streams (`GET /v1/realtime/stream`, Ask OCSO chat)
authenticate like every `/v1` route and re-check their session every minute, closing when it was
revoked or expired (ADR-025). Authentication itself is Better Auth at `/api/auth/*` (browsers reach it
on the public origin through the web app); `/v1/auth/me` describes the signed-in user and their MFA
state.

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
