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
- Authentication is Better Auth, self-hosted inside the API (ADR-025); authorization (roles → permissions, the deny-by-default guard, conversation-level checks) is OCSO's and unchanged.
  - Sessions: Better Auth session rows with an httpOnly, `SameSite=Lax` cookie (`ocso.session_token`, `__Secure-` prefixed and Secure when `SESSION_COOKIE_SECURE`/https) on the public origin; the web BFF forwards it to the API as a signed Bearer token (ADR-020 unchanged: browsers never call `/v1`). Absolute lifetime `SESSION_ABSOLUTE_HOURS` (no sliding refresh) plus an idle window `SESSION_IDLE_MINUTES`. Role change, deactivation, password reset and recovery end the user's sessions; long-lived streams re-check their session every minute and close.
  - Only reviewed Better Auth endpoints answer over HTTP at `/api/auth/*` (an allowlist pinned by a test); sign-up and user self-service updates do not exist. Cookie-bearing auth requests pass Better Auth's origin/CSRF checks; cookie-authenticated POST routes of the web app also require a same-origin request.
  - Passwords: OCSO scrypt (`scrypt$15$8$1$…`), at least 12 characters. New users are invited (single-use link, 72 h) and choose their own password; forgotten passwords are reset through a 1-hour emailed link; changing a password needs the current one and signs out other sessions.
  - Second factors: TOTP authenticator apps with 10 single-use backup codes (secrets and codes encrypted with `BETTER_AUTH_SECRET`), and passkeys (WebAuthn, user verification required). The Tech Admin can require MFA per role; a password-only session of such a role can do nothing but enrol. Passkey and SSO sessions count as multi-factor (the IdP enforces its own policy).
  - SSO: OIDC and SAML 2.0 providers bound to email domains, managed only by the Tech Admin (client secrets write-only; stored in `auth_sso_providers`, protect database backups). An IdP can vouch only for its own domains; it links existing users by email; creating unknown users (as CS Exec) is opt-in per provider.
  - Throttling: Better Auth's rate limiter in the database (shared by all API instances) per client address, plus per-account (8 failures / 15 min) and per-address sign-in throttling and a two-factor lockout after 10 failures. The client address is the web tier's trusted-proxy-hop value; it is never taken from the browser.
  - Every authentication event is audited (sign-in/out and failures without the typed credentials, resets, invites, MFA and passkey changes, session revocations, SSO provider changes and refusals, recovery).
  - Break-glass: at least one active Tech Admin always keeps password sign-in (the API refuses the change that would remove the last one); `OCSO_RECOVERY_TOKEN` enables a one-time, audited password + authenticator reset for a locked-out Tech Admin.
- Secrets live only in the secret store (local AES-GCM or AWS Secrets Manager) and are never returned by the API; the Tech Admin sees an inventory of names, usage and expiry.
- Outbound calls to admin-configured endpoints (MCP servers, alert and webhook destinations) go through an SSRF guard; webhook payloads carry identifiers and metadata only and are signed (`X-OCSO-Signature`).
