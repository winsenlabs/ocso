# MCP, Tools and Authentication

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

Tech Admin can add an MCP server and authenticate it without writing application code.

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
- Customer identity claims (§4): ES256 JWT, 120 s lifetime, claims `iss sub aud iat nbf exp jti cid agt scope` only, `sub` = the business customer reference when known; public keys at `/.well-known/jwks.json`; rotation keeps the previous key published for 24 h. Sent only to connections marked trusted, on both the agent path and human-confirmed calls.
- Sensitive-action confirmation executes exactly the arguments shown (held server-side, hash-checked, cleared on decision/expiry) and is attributed to the confirming human.
