# MCP, Tools and Authentication

> [!IMPORTANT]
> **Original design spec (2026-09): parts are superseded; see [mcp.md](../../guides/tools/mcp.md).** This page is kept for history. Where it and the code disagree, the code and [PM/ARCHITECTURE-DECISIONS.md](../../../PM/ARCHITECTURE-DECISIONS.md) win. Links inside it may point to pages that have since moved.

## 1. Boundary

OCSO orchestrates conversations. External systems perform business capabilities.

Examples:
- CRM
- order management
- payment system
- loan/core system
- ticketing
- internal knowledge
- custom backend

These systems connect through MCP or an approved tool adapter.

## 2. MCP connection manager

A Tech admin can add an MCP server and authenticate it without writing application code.

The platform should support:
- server URL/config
- capability discovery
- OAuth 2.1 flows where supported
- token refresh/lifecycle
- connection health
- tool schema synchronization
- enable/disable
- per-agent authorization

## 3. Connection scopes

### Shared connection
Configured centrally and available subject to policy.

### User connection
Configured by an individual user where policy permits, analogous to attaching a personal tool/MCP integration.

Effective tools are resolved from:
- agent-enabled tools
- shared connections
- current user's connections where relevant
- policy restrictions
- channel/conversation restrictions

## 4. Customer identity claims

For customer-facing business calls, OCSO may issue a short-lived signed JWT or equivalent trusted claim to the Bridge/tool server.

Claims may include only necessary identifiers/scopes:
- subject/customer reference
- conversation ID
- agent ID
- approved scopes/actions
- issued/expiry time
- nonce/request correlation

Do not put secrets or unnecessary PII into claims.

## 5. Credentials

Raw provider/tool credentials must never enter model context.

Secrets are referenced by ID and resolved only inside trusted execution code.

## 6. Tool authorization

Before a tool call:
1. tool exists
2. connection healthy/usable
3. agent allowed
4. acting principal allowed
5. requested scope allowed
6. argument schema valid
7. confirmation/approval requirement satisfied
8. policy allows action

## 7. Side effects

Classify tools:
- read-only
- reversible write
- sensitive/irreversible write

Higher-risk actions may require explicit human confirmation according to policy.

## 8. Audit

Persist:
- conversation
- agent/human actor
- tool and connection
- sanitized arguments
- status/result metadata
- latency
- correlation ID
- approval/confirmation
- error classification

Do not log secrets.

## Implementation notes (as built)

- OAuth 2.1 client registration order: Client ID Metadata Document → pre-registered client → dynamic registration; PKCE S256, `state` (stored hashed, single use) and RFC 9207 `iss` checks; every MCP/metadata/token request goes through an SSRF-guarded fetch (ADR-021).
- Connection names are slugs because they prefix model-facing tool names; plain `http://` only for allowlisted internal hosts; a changed tool definition (schema, description, annotations) is un-approved until reviewed.
- Customer identity claims (§4): ES256 JWT, 120 s lifetime, claims `iss sub aud iat nbf exp jti cid agt scope` only (plus `ocso_channel` and host `ctx` from verified web chat sessions), `sub` = the business customer reference when known, else a user id the conversation's own channel verified (then `ocso_channel` names it); public keys at `/.well-known/jwks.json`; rotation keeps the previous key published for 24 h. Sent only to connections marked trusted, on both the agent path and human-confirmed calls.
- Sensitive-action confirmation executes exactly the arguments shown (held server-side, hash-checked, cleared on decision/expiry) and is attributed to the confirming human.
- Agent tool grants under maker–checker (PM/research/11 §4; kind `agent_tool_grant`, object = the agent, checked with `approvals.check.agents`). A draft agent's grant set is written whole (its go-live approval shows the tools). Once the agent (or its set) is approved, `PUT /v1/agents/:id/tools` splits the change: removals and narrowing (a tool turned off, confirmation turned on, argument rules only added) apply at once, never locked by an open proposal; anything that widens access (a new tool, turning one on, dropping confirmation or an argument rule) becomes one UPDATE proposal carrying only those grants — 202 `{proposal, applied}` with `approval`, else 409 `approval_required` saying what already applied. Approval re-checks that every proposed tool is still grantable.
