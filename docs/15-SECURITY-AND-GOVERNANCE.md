# Security and Governance

## 1. Trust boundaries

Important boundaries:
- customer/channel -> OCSO
- human browser -> OCSO
- OCSO -> model provider
- OCSO -> MCP/tool server
- OCSO -> secret store
- OCSO -> blob store

Authenticate, authorize and validate at each boundary.

## 2. Single tenant does not mean single user

Single-tenant simplifies organization isolation but RBAC remains mandatory.

Every privileged API checks user role/capability.

## 3. Secrets

Never:
- put secrets in model prompts
- put secrets in telemetry
- persist plaintext production secrets in ordinary configuration tables
- return secrets to browser clients after setup

Use secret references and server-side resolution.

## 4. Customer/channel authentication

Channel adapters verify provider signatures/tokens and deduplicate replayed webhook events.

Customer identity resolution must be deterministic and auditable.

## 5. MCP/tool security

- OAuth/token refresh handled server-side
- minimum scopes
- per-agent authorization
- per-user authorization where applicable
- connection health
- outbound allowlist/SSRF protections
- TLS
- tool argument validation
- audit side effects

Treat arbitrary MCP endpoints as untrusted network destinations until approved.

## 6. Prompt injection/tool abuse

Separate:
- customer-provided content
- tool descriptions/results
- system instructions
- hidden policy

Do not allow customer text or tool output to override system authorization. Authorization is enforced in code, not prompt text.

## 7. Audit

Immutable audit entries for:
- login/security events as appropriate
- role changes
- provider/channel/MCP config changes
- prompt activation
- worker/scaling config changes
- human takeover/return-to-AI
- sensitive tool actions
- alert acknowledgement/resolution
- internal-agent administrative actions

## 8. Data retention

Make retention configurable for:
- conversation content
- media
- logs
- traces
- tool payloads
- audit events

Audit requirements may differ from conversation retention.

## 9. Encryption

Use TLS in transit and appropriate encryption at rest for PostgreSQL, blob storage and secret stores in production.

## Implementation notes (as built)

- Retention (§8) is configured per class in Settings: conversation content (resolved conversations; structure and analytics kept), media bytes, tool payloads, Ask OCSO history, model usage, operational records and audit events. The worker applies it hourly in bounded batches and audits each run. Audit rows can only be deleted past a cutoff the database itself refuses to set below 365 days. Logs and traces are retained by their backends.
- Audit events are append-only at the database level; prompt versions are immutable once activated.
- Sessions: random tokens stored hashed, idle and absolute expiry, httpOnly `SameSite=Lax` cookie held by the web tier (ADR-020); cookie-authenticated POST routes also require a same-origin request. Sign-in is throttled per account and per verified client address (the web tier forwards the address from its trusted proxy hop).
- Secrets live only in the secret store (local AES-GCM or AWS Secrets Manager) and are never returned by the API; the Tech Admin sees an inventory of names, usage and expiry.
- Outbound calls to admin-configured endpoints (MCP servers, alert and webhook destinations) go through an SSRF guard; webhook payloads carry identifiers and metadata only and are signed (`X-OCSO-Signature`).
