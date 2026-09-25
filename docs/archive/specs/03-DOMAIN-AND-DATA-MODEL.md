# Domain and Data Model

> [!IMPORTANT]
> **Original design spec (2026-09): parts are superseded; see [conversations.md](../../concepts/conversations.md), [routing.md](../../concepts/routing.md).** This page is kept for history. Where it and the code disagree, the code and [PM/ARCHITECTURE-DECISIONS.md](../../../PM/ARCHITECTURE-DECISIONS.md) win. Links inside it may point to pages that have since moved.

## 1. Single-tenant rule

OCSO is single-tenant. Do not add `tenant_id` to every table.

A deployment belongs to one organization. Organization-level metadata may exist as deployment/profile settings, but it is not a SaaS tenant discriminator.

## 2. Core entities

### User
Human account.

Fields:
- id
- name
- email/login identity
- role: TECH | HEAD | LEAD | SERVICE (a preset, ADR-029; migration 0021 mapped PLATFORM_TECH_ADMIN → TECH, CS_LEAD → HEAD, CS_EXEC → SERVICE)
- per-user permission grants and revokes (`user_permission_grants`, optional expiry)
- status
- team memberships
- created_at / updated_at

### VirtualAgent
Named AI employee.

Fields:
- id
- name
- slug
- purpose/type
- description
- status
- active_prompt_version_id
- model_policy_id
- escalation_policy_id
- default_queue_id
- multimodal settings
- channel policy
- created_at / updated_at

### AgentVersion / PromptVersion
Immutable/versioned agent configuration snapshots. Changes should be reviewable and attributable.

### Customer
Canonical external person/account entity.

### CustomerIdentity
Maps channel-specific identity to Customer:
- whatsapp phone identity
- web user identity
- external customer reference
- future channel identities

### Conversation
Fields:
- id
- customer_id
- virtual_agent_id
- type: SUPPORT | SALES | COLLECTIONS | ONBOARDING | CUSTOM
- state
- control_mode: AI | WAITING_HUMAN | HUMAN | RESOLVED
- channel/source
- queue_id
- assigned_user_id nullable
- active_worker_lease_id nullable
- summary/current state reference
- priority
- timestamps

### Interaction
One logical conversational turn/event.

Fields:
- id
- conversation_id
- actor_type: CUSTOMER | AGENT | HUMAN | SYSTEM | TOOL
- actor_id where relevant
- direction
- timestamp
- correlation_id
- visibility

### InteractionPart
Multiple parts per interaction:
- TEXT
- IMAGE
- AUDIO
- VIDEO
- DOCUMENT
- LOCATION
- CONTACT
- STRUCTURED
- TOOL_RESULT

Media bytes are externalized to blob storage.

### Queue
Business queue with eligibility and pickup/assignment policy.

### Assignment
History of ownership/claim transitions.

### Handoff
Why and when human intervention was requested, assigned, accepted, returned or resolved.

### ToolConnection
Configured external connection. Scope:
- SHARED
- USER

Fields include provider type, server URL, auth strategy, secret reference and health metadata.

### ToolAuthorization
Who/what can use a connection:
- virtual agent
- user
- team/policy

### ToolCall
Auditable invocation with:
- tool name
- sanitized arguments
- actor
- conversation
- latency
- result status
- error
- external correlation ID

Never store secrets in tool-call payloads.

### ModelProfile
Logical runtime profile independent of provider-specific model identifiers.

### ModelProviderConfig
Provider adapter config, region/endpoint and secret reference.

### UsageEvent
Normalized tokens, cached tokens, latency, provider/model, cost metadata when available.

### AlertRule / Alert
Rule definitions and opened/acknowledged/resolved alert instances.

### AuditEvent
Immutable record of privileged actions and configuration changes.

## 3. Conversation state

Recommended high-level control states:
- AI_ACTIVE
- ESCALATION_REQUESTED
- WAITING_FOR_HUMAN
- HUMAN_ACTIVE
- AI_RESUMING
- RESOLVED

Business status may be orthogonal to control state.

## 4. Persistence principles

- complete interaction history is append-oriented
- mutable projections may optimize read UX
- summaries are derived state
- cache entries are derived state
- prompt versions are immutable
- privileged changes create audit events
- recoverability must not depend on worker memory

## 5. Indexing priorities

Index for:
- conversation by state/queue/priority
- conversation by customer
- conversation by assigned exec
- recent interactions by conversation
- customer identity lookup by provider identifier
- active worker leases
- unresolved alerts
- tool calls by conversation/status
- usage events by time/agent/provider

Use database migrations for every schema change.
