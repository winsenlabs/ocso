# Agent Runtime

> [!IMPORTANT]
> **Original design spec (2026-09): parts are superseded; see [conversations.md](../../concepts/conversations.md), [virtual-agents.md](../../concepts/virtual-agents.md).** This page is kept for history. Where it and the code disagree, the code and [PM/ARCHITECTURE-DECISIONS.md](../../../PM/ARCHITECTURE-DECISIONS.md) win. Links inside it may point to pages that have since moved.

## 1. Runtime responsibility

The agent runtime owns one turn of execution while preserving the broader conversation lifecycle.

It must support:
- streaming model output
- tool calling
- multiple tool steps
- multimodal input
- retry and timeout policy
- cancellation
- human escalation
- provider fallback subject to policy
- usage reporting
- prompt and turn caching
- durable checkpoints

Use Vercel AI SDK as the primary model/tool-loop integration layer, behind OCSO-owned interfaces.

## 2. Do not make the SDK the architecture

Vercel AI SDK should own:
- model invocation
- stream normalization
- structured generation
- tool-call protocol
- provider-facing primitives

OCSO owns:
- conversation lifecycle
- identity
- policy
- prompt assembly
- permissions
- tool authorization
- human handoff
- queues
- alerts
- audit
- usage accounting

## 3. Turn lifecycle

1. Receive canonical interaction.
2. Persist it.
3. Resolve active conversation/agent/customer state.
4. Acquire/confirm conversation lease.
5. Resolve effective tools and permissions.
6. Compile prompt/context.
7. Select logical model profile/provider.
8. Start streaming generation.
9. Execute authorized tool calls as requested.
10. Continue tool/model loop until terminal response or handoff.
11. Persist all relevant events/results.
12. Render customer-safe output through channel adapter.
13. Update summary/cache/projections asynchronously where safe.
14. Release or refresh active lease according to policy.

## 4. Durable checkpoints

At minimum persist:
- inbound interaction before execution
- tool request before external side effect
- tool result/error after execution
- completed assistant interaction
- handoff/control-state transition

Use idempotency keys for inbound webhooks and side-effecting tool calls where supported.

## 5. Tool loop policy

Every call must pass:
- tool is available to agent
- connection is available
- calling principal is authorized
- business policy allows the action
- required confirmation has been obtained
- argument validation succeeds

Tool errors must be typed. Do not dump raw exceptions into the model.

## 6. Human mode

When `HUMAN_ACTIVE`:
- external customer messages still persist and stream to the CS UI
- agent must not independently send customer-facing responses
- optional copilot generation may be enabled separately
- agent context continues to track the shared history
- a permitted human can return control to AI

## 7. Cancellation and races

Conversation execution must be serialized at the conversation level or use a clearly defined optimistic/versioned strategy.

Avoid two workers generating customer replies for the same conversation simultaneously.

New customer messages arriving mid-turn should either:
- cancel/restart the turn when safe, or
- queue behind the active turn

This behavior must be deterministic and configurable.

## 8. Context strategy

The runtime should normally use:
- stable compiled agent prefix
- customer/business context
- rolling conversation summary
- recent interactions
- current interaction
- relevant retrieved historical events when needed

Do not resend unbounded full history forever.
