# Security and Governance

> [!IMPORTANT]
> **Original design spec (2026-09): parts are superseded; see [governance.md](../../concepts/governance.md), [audit.md](../../concepts/audit.md), [sign-in.md](../../guides/sign-in.md).** This page is kept for history. Where it and the code disagree, the code and [PM/ARCHITECTURE-DECISIONS.md](../../../PM/ARCHITECTURE-DECISIONS.md) win. Links inside it may point to pages that have since moved.

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

- Retention (§8) is configured per class in Settings: conversation content (resolved conversations; structure and analytics kept), media bytes, tool payloads, Ask OCSO history, model usage, operational records and audit events. The worker applies it hourly in bounded batches and audits each run. The audit class applies to the audit store (below): whole months past it are dropped, never anything younger than the store's own minimum retention (`AUDIT_MIN_RETENTION_DAYS`, at least 365, set by the migrate step — see the trust boundaries below for who can go under it). The main database keeps a local window of audit events (`audit_local_window_days`, default 90, minimum 90 so the 90-day analytics windows keep their markers) and prunes only rows the store has verified, after checking once more that the store still holds them. Logs and traces are retained by their backends.
- Audit events are append-only at the database level; prompt versions are immutable once activated.
- **Audit store (§7, ADR-032).** Every audit event is still written in the same transaction as the change it records (`audit_events` in the main database, now the transactional outbox, carrying the teams the event concerns). The worker leader ships events to the **audit store**, a separate database selected by `AUDIT_DRIVER` (`postgres`, the default, or `clickhouse`), within seconds, idempotently; reconciliation proves each one arrived before the local copy may ever be pruned, and re-sends any the store lost. Guarantees:
  - *Who can change or remove audit history (trust boundaries).* The worker holds the **writer** (INSERT/SELECT, plus EXECUTE on the partition and purge functions); the api holds a **reader** (SELECT only) where the deployment provisions one (Compose and the AWS reference do); owner credentials exist only in the migrate step (`audit-migrate`). What each can do:
    - *postgres driver.* Writer and reader cannot UPDATE, DELETE, TRUNCATE or drop anything; triggers refuse UPDATE/DELETE/TRUNCATE for every role, the owner included — but the owner (or a superuser) can `DISABLE TRIGGER`, so the owner credentials are what an auditor must control. The writer can remove history only through `audit_purge_before`, which drops whole months older than the owner-set minimum retention (`audit_store_config`, which the writer can neither read nor change) and logs every drop in the append-only `audit_purges`. Verification counts a missing record as purged only under a logged purge; anything else is `RECORD_MISSING`. The writer *can* insert a second copy of a record under another time (the key includes the time); the chain seals the first and verification reports the copy (`RECORD_CONFLICT`). Production refuses to provision a writer that is the owner or a superuser unless `AUDIT_ALLOW_OWNER_WRITER=true`, and the System screen warns when connected credentials are the owner's or when the api can write.
    - *clickhouse driver: tamper-evident, not append-only.* ClickHouse has no triggers and no unique keys. The writer has SELECT/INSERT only, so it cannot alter or delete rows, but an INSERT can add a second copy of a record or a second chain row at a position: reads keep the first copy, and verification reports `RECORD_CONFLICT` / `CHAIN_FORK`. The optional purge user (worker only) holds ALTER DELETE, which ClickHouse requires to drop a partition and which also allows deleting rows: the minimum retention is enforced by the driver, not the server, and every drop is logged in `audit_purges`. Treat the purge user like owner credentials.
    - *Deployments.* Compose runs the store on its own server (`audit-db`); the owner password lives only in the migrate step's secrets, the writer URL in a subpath only the worker mounts. The AWS reference puts it on its own RDS instance whose master user only the migrate task receives (`audit_store.separate_instance`, default true). With `separate_instance = false` the audit database shares the main instance, whose master user the api and worker hold, so a compromised api could disable the triggers and rewrite or drop audit data: the plan warns; do not use it for a bank deployment.
  - *Tamper evidence.* Records are sealed in arrival order into a SHA-256 hash chain (`recordHash = sha256(canonical JSON)`, `chainHash = sha256(prevHash ‖ recordHash)`, genesis 64 zeros); one sealer at a time (a lock in the main database fences overlapping leaders). Every 1 000 entries or hourly the worker re-verifies what is new since the last checkpoint (at most 50 000 entries per run, checkpointing long ranges in steps) and signs a checkpoint with the deployment's Ed25519 key (`AUDIT_SIGNING_KEY_FILE`; public keys at `GET /v1/audit/keys`). New problems open or widen a `CHAIN_BROKEN` incident recording where the break is; nothing is signed over it, but later ranges that verify on their own are still checkpointed and exported. Someone with `audit.verify` closes the incident with a note after investigating (`POST /v1/audit/incidents/:id/acknowledge`, audited; nothing in the store changes, and later verifications treat that range as a known break). Every day the worker also re-verifies the **whole** chain in pages (`audit-verify-full`), so a record altered long ago is found; the System screen shows the last full check. Daily exports write the sealed range with a signed manifest to the blob store (`audit-exports/…`); `EXPORT_FAILED` says so when no new signed checkpoint allows an export for two days. An export is an independent copy only if the blob store enforces write-once retention on `audit-exports/` (S3 Object Lock); otherwise whoever holds the blob credentials can replace it.
  - *Keys.* Verify against keys you pinned yourself (`GET /v1/audit/keys`, or your own records of the key id), never the public key an export manifest carries — a forger would replace both. `audit.verify` events record the key ids used. Rotating the key: keep the old public key in `AUDIT_TRUSTED_PUBLIC_KEYS(_FILE)` so older checkpoints still verify; a checkpoint signed by a key the deployment does not trust opens `SIGNING_KEY_CHANGED` (a lost or silently replaced key shows up there). On AWS the key is its own secret, independent of bootstrap rotations.
  - *Verification.* `POST /v1/audit/verify` (`audit.verify`, audited; latest 10 000 entries by default) and the `audit-verify` bin (any range, no cap, offline with public keys) re-check every link, every record's hash, every checkpoint signature, forks and conflicting copies. The bin also fails when no valid checkpoint signs the range, when more than `--max-unsigned` (default 5 000) entries follow the last one, or when records exist but nothing was ever sealed. Records removed by a logged purge still link and are reported as purged.
  - *Reads.* The audit screen reads the store merged with events not yet confirmed in it (unshipped, or shipped but not yet verified), so shipping lag never hides an event. Scope: `audit.read_all` sees everything; everyone else sees events they performed, events concerning one of their teams (the target's teams ∪ the actor's teams, fixed when the event was written) and changes to shared queue/SLA/team/router/channel/template configuration. If the store is down or does not answer within 5 seconds, the screen serves the main database's local window and says so in a banner. Events from before the audit store existed were given only their target's teams (and an agent actor's), not the acting user's current teams, which may not be the teams they acted for.
  - *Failure isolation.* Every store call is time-bounded (`AUDIT_STORE_TIMEOUT_MS`, connect 5 s); the audit tasks have a deadline and pause while the shipper backs off from a failing store, so a store that stops answering delays only audit shipping, never the worker's other leader tasks or the api.
  - *Restoring the store from a backup.* Events shipped after the backup point are gone from the restored store although the main database marks them verified. Before the local prune deletes anything it checks the store again and re-ships what it no longer holds, but only within the local window: restore within `audit_local_window_days` of the backup, then run reconciliation (it runs every 5 minutes) and `audit-verify`. The restored chain restarts at the backup's head, so positions after it are sealed again with different content than earlier exports covered: keep those exports; verification of each export against its own manifest still holds, and the System screen shows the new chain. Back up `auditdata` (Compose) / the audit instance (AWS) at least as often as the main database. The upgrade backfill of `team_ids` rewrites every audit row in one statement: expect minutes per million rows, and run `VACUUM (ANALYZE) audit_events` afterwards.
  - *What changed in the guarantee.* The audit row and the change still commit together (the outbox row). The store copy is no longer atomic with the change: it arrives within seconds, at least once. Compensations: outbox atomicity, reconciliation before any local prune, incidents (`SHIP_FAILED`, `STORE_DOWN`, `RECONCILE_MISSING`, `CHAIN_BROKEN`, `EXPORT_FAILED`, `SIGNING_KEY_CHANGED`; shipping incidents clear on the next successful round, whichever worker opened them) listed on the System screen and in the exception report, and the merged read. Readiness does not depend on the store.
  - *Team scope is resolved at write time.* An event keeps the teams it concerned when it happened; later membership changes do not re-scope old events.
- Authentication is Better Auth, self-hosted inside the API (ADR-025); authorization (roles → permissions, the deny-by-default guard, conversation-level checks) is OCSO's and unchanged.
  - Sessions: Better Auth session rows with an httpOnly, `SameSite=Lax` cookie (`ocso.session_token`, `__Secure-` prefixed and Secure when `SESSION_COOKIE_SECURE`/https) on the public origin; the web BFF forwards it to the API as a signed Bearer token (ADR-020 unchanged: browsers never call `/v1`). Absolute lifetime `SESSION_ABSOLUTE_HOURS` (no sliding refresh) plus an idle window `SESSION_IDLE_MINUTES`. Role change, deactivation, password reset and recovery end the user's sessions; long-lived streams re-check their session every minute and close.
  - Only reviewed Better Auth endpoints answer over HTTP at `/api/auth/*` (an allowlist pinned by a test); sign-up and user self-service updates do not exist. Cookie-bearing auth requests pass Better Auth's origin/CSRF checks; cookie-authenticated POST routes of the web app also require a same-origin request.
  - Passwords: OCSO scrypt (`scrypt$15$8$1$…`), at least 12 characters. New users are invited (single-use link, 72 h) and choose their own password; forgotten passwords are reset through a 1-hour emailed link; changing a password needs the current one and signs out other sessions.
  - Second factors: TOTP authenticator apps with 10 single-use backup codes (secrets and codes encrypted with `BETTER_AUTH_SECRET`), and passkeys (WebAuthn, user verification required). Tech can require MFA per preset; a password-only session of such a role can do nothing but enrol. Passkey and SSO sessions count as multi-factor (the IdP enforces its own policy).
  - SSO: OIDC and SAML 2.0 providers bound to email domains, managed only by Tech (client secrets write-only; stored in `auth_sso_providers`, protect database backups). An IdP can vouch only for its own domains; it links existing users by email; creating unknown users (as CS Exec) is opt-in per provider.
  - Throttling: Better Auth's rate limiter in the database (shared by all API instances) per client address, plus per-account (8 failures / 15 min) and per-address sign-in throttling and a two-factor lockout after 10 failures. The client address is the web tier's trusted-proxy-hop value; it is never taken from the browser.
  - Every authentication event is audited (sign-in/out and failures without the typed credentials, resets, invites, MFA and passkey changes, session revocations, SSO provider changes and refusals, recovery).
  - Break-glass: at least one active Tech admin always keeps password sign-in (the API refuses the change that would remove the last one); `OCSO_RECOVERY_TOKEN` enables a one-time, audited password + authenticator reset for a locked-out Tech Admin.
- Secrets live only in the secret store (local AES-GCM or AWS Secrets Manager) and are never returned by the API; Tech sees an inventory of names, usage and expiry.
- Outbound calls to admin-configured endpoints (MCP servers, alert and webhook destinations) go through an SSRF guard; webhook payloads carry identifiers and metadata only and are signed (`X-OCSO-Signature`).
- Maker–checker (PM/research/11 §4, 11b; ADR-030). A change to live configuration is a *proposal* (`approval_proposals`) with a named checker who holds the kind's `approvals.check.*` permission, is ACTIVE, shares a team with the object (platform-wide objects: any holder) and is not the maker. When nobody in the owning teams could check it (a team whose only Head is the maker), any ACTIVE holder of the check permission may — the platform-wide fallback — so reshaping a team's owners or membership can never manufacture a self-approval. Proposing is scoped like writing (owning team), never by read scope. An object never approved is a draft, freely editable and inert; its first approval makes it live; from then on every change is a proposal, and ACTIVATE (go live, resume) and DELETE always are. "Approved" is derived from the proposal table, never a column on the object.
  - One open proposal per object (partial unique index + advisory lock); while it is open the object is locked (409 `approval_open`). Objects that describe one configuration share the lock: an agent and its prompt versions lock each other, and the agent's owners, tool grants and escalation rules are locked while either has a proposal open. Submit, decision and the direct write paths take the same lock, and a decision reads the object only after taking it. Stop actions — pausing an agent, and in later waves disabling channels/routers/connections, removing tool grants, reducing rights — never go through the spine and are allowed while a proposal is open.
  - The checker approves exactly what they saw: a content hash (the object's state before the change — identifiers, not display names, so a rename elsewhere voids nothing — + the change + revision) and a dependency hash (`kind:id@updated_at` of what the change relies on) are recomputed at decision; a mismatch with the hashes stored at submit is 409 `content_changed` / `dependency_changed` (the maker refreshes by editing). Rejecting never needs matching hashes. "Take X live" shows the checker the full configuration going live: prompt text, tool grants, escalation rules. A proposal that changes nothing visible is refused. Approval and activation share one transaction; validation runs again inside it and failures end the proposal BLOCKED with the object untouched. Kinds whose activation leaves the transaction (provider calls) are finished by the worker (`approval.activate`), which re-validates and re-checks both hashes before calling out.
  - Decisions are re-authorised from the database at decision time (a checker disabled, stripped of the permission or moved out of the owning teams since submit cannot decide — `checker_invalid`). The checker sweep only flags a checker who lost their rights (`checker_valid`); reassignment is always a person with `approvals.reassign_any` or the kind's check permission, and the new checker must be eligible.
  - Bootstrap: only when nobody but the maker anywhere in the deployment could check a proposal (the fallback above included) and the maker holds the check permission may they approve it themselves; it is recorded as `BOOTSTRAP_APPROVE` (and listed by the exception report).
  - Proposals nobody can decide do not lock objects forever: a holder of `approvals.reassign_any` voids one with a reason (VOID decision + audit), and the leader sweep voids open proposals whose object is gone or whose maker is no longer ACTIVE or no longer holds the make permission.
  - `approval_decisions` is append-only (UPDATE/DELETE/TRUNCATE rejected by trigger), and a proposal is frozen once decided (trigger: never deleted; created SUBMITTED unless grandfathered; maker, object and action never change; after the decision only APPROVED→BLOCKED before activation and the activation/notification stamps change; `CHECK` refuses a decision recorded by its own maker outside bootstrap, withdraw and void); every decision also writes an audit event with target type `approval`. Proposal payloads are replayed on activation, so they are stored raw and never returned over HTTP; a payload never carries a secret value (pinned by a test per kind).
  - Deleting an agent is an approval (`agents.delete`, Head) and is refused for agents that served conversations (pause them instead); the prompt versions of an approved deletion are the one case the prompt-version immutability trigger lets through: the trigger itself checks for that agent's APPROVED, user-made DELETE proposal (no session flag). A channel's deprecated `default_agent_id` pointing at the agent is cleared first.
  - Business and identity kinds (wave 2, COVERAGE-BUSINESS): `agent_tool_grant` (widening an approved agent's tools; removals and narrowing apply at once), `escalation_rule` (created off; on/resume = ACTIVATE; off is immediate), `alert_rule` and `alert_rule_technical` (one table, two kinds and check permissions; created off; off is immediate), `message_template` (drafts in OCSO only; submission and deletion finished at the provider by the worker), `user` (activation in the approval, invite from the worker) and `permission_change` (PERMS' change set, re-validated against the maker at approval). Their `liveObjects()` are exact for the grandfather migration: enabled rules, templates OCSO put at the provider, ACTIVE users, and — for tool grants and grants — only what no approval covers. Configuration OCSO installs before anyone could check it (the setup admin, the default alert rules) is recorded like grandfathered configuration (`origin = 'MIGRATION'`).
