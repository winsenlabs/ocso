# 11 — Governance and routing: people, maker–checker, routers, the audit store, exceptions

Status: DESIGN for PR `feat/governance-routing` (after v1, #1). Owner decisions from the 2026-09-22/23 sessions;
every item below marked **Decided** was confirmed by the product owner. Engineering decisions are marked **Eng**.
Detailed approval-spine design: `11b-approvals-detail.md` (this file wins where they differ).

Out of scope for this PR (next PR): the plugin SDK (`@winsendotai/ocso-plugin-sdk` + loader), the chat SDK
(`@winsendotai/ocso-chat` core + `@winsendotai/ocso-chat-react`, web and React Native, host-context, publishable
key + server-minted session pass, host JWKS user tokens, OCSO-vouched vs pass-through tool identity), Ask OCSO as a
whole-platform copilot, the logo.

---

## 1. The model in one page

- **People.** Four presets — **Tech, Head, Lead, Service** — replace the three roles. A user's rights are their
  preset plus per-user grants minus per-user revokes; grants may expire. Everyone, Head included, acts only inside
  the teams they belong to. Approval rules are written in permissions, never levels.
- **Maker–checker.** Every create/change/delete of configuration is a *proposal* with a named checker who holds the
  approval permission for that kind of object and is not the maker. Objects never approved are drafts, freely
  editable and inert; the first approval makes them live; after that every change is a proposal. Stopping (pause,
  disable, revoke, reducing someone's rights) is never gated. One approval per object; bulk approve in the queue.
- **Routing.** `channel → router → queue → agent`. A router is pass-through, a menu (orchestrator), a model
  classifier (which may ask follow-ups), or any mix. Returning customers are asked continue-or-new after a
  configurable gap. A queue is the service unit: exactly one AI agent, human teams, SLA, hours, attributes
  (`language=ta, product=sales`), and the queues it may transfer to. Conversations move between queues keeping history.
- **Audit store.** The main database keeps writing `audit_events` in the same transaction as each change — it is
  now the *transactional outbox* plus a recent local window. A shipper moves rows to the **audit store**, a separate
  database selected at bootstrap through a driver plugin (`postgres` now, `clickhouse` too). The store is the system
  of record: append-only privileges, a hash chain sealed by the worker with Ed25519-signed checkpoints, signed exports,
  a verify command.
- **Exceptions.** A weekly auditor-grade report (signed, exportable, tamper-evident) of everything that went around
  or wrong in the controls, plus a live view; and a storage growth report.

---

## 2. Decisions (all confirmed)

1. **Decided** Four presets Tech/Head/Lead/Service. Existing users map: `PLATFORM_TECH_ADMIN→TECH`,
   `CS_LEAD→HEAD` (keeps their current authority to take agents live), `CS_EXEC→SERVICE`. `LEAD` is new.
2. **Decided** Head is team-scoped and may belong to many teams.
3. **Decided** Per-user permissions: preset + grants − revokes; grants may expire; permission increases need
   approval, decreases are immediate (stopping is never blocked).
4. **Decided** Head and Lead may pause; Service may not. Deleting agents/templates: Head preset only, and via approval.
   Resuming a paused/disabled object is an ACTIVATE and needs approval.
5. **Decided** Maker names the checker. Lead→Head, Head→another Head, or anyone granted checker rights. Tech sees
   all open approvals and reassigns, holding checker rights itself. One approval per object; bulk approve with the
   warning carve-out; diffs; edit voids approval; re-validate at activation.
6. **Decided** Bootstrap: when no eligible checker other than the maker exists, a maker who holds that kind's check
   permission may approve their own proposal; recorded as `BOOTSTRAP_APPROVE` and listed in the exception report.
   Disabled automatically once another eligible checker exists.
7. **Decided** Approvable = every configuration object including users (creation and preset upgrades), permission
   grants, alert rules, notification destinations, webhook subscriptions.
8. **Decided** One open conversation per (customer, channel); routing and transfers happen inside it.
9. **Decided** Router kinds pass-through / menu / model; the model may ask follow-ups; returning customers get
   continue-or-new after a per-router gap in hours/days/months; router messages are free text with an optional
   per-channel template mapping created in one click.
10. **Decided** Exactly one AI agent per queue; one agent may serve many queues; queues defined by attributes; the
    queue carries hours (moved from the agent) and an explicit list of transfer targets.
11. **Decided** Audit store is a driver plugin in its own database (postgres now + clickhouse built), chosen at
    bootstrap; the main DB keeps the same-transaction write (outbox). Auditor grade.
12. **Decided** Reads never need approval.

---

## 3. People and permissions (area PERMS)

### 3.1 Permission catalogue changes (`packages/auth/src/permissions.ts`)
New constants:
```
AGENTS_PAUSE 'agents.pause'                  AGENTS_DELETE 'agents.delete'
MESSAGE_TEMPLATES_DELETE 'message_templates.delete'
ROUTERS_READ 'routers.read'                  ROUTERS_MANAGE 'routers.manage'
APPROVALS_READ 'approvals.read'              APPROVALS_REASSIGN_ANY 'approvals.reassign_any'
APPROVALS_CHECK_AGENTS 'approvals.check.agents'        // agent, prompt_version, agent_tool_grant, escalation_rule, business alert_rule
APPROVALS_CHECK_ROUTING 'approvals.check.routing'      // router, queue, sla_policy
APPROVALS_CHECK_CHANNELS 'approvals.check.channels'    // channel, message_template
APPROVALS_CHECK_PLATFORM 'approvals.check.platform'    // model_provider, model_profile, mcp_connection, notification_destination,
                                                        // webhook_subscription, technical alert_rule, deployment_settings
APPROVALS_CHECK_PERMISSIONS 'approvals.check.permissions' // user, permission_change
PERMISSIONS_READ 'permissions.read'          PERMISSIONS_MANAGE 'permissions.manage'
EXCEPTIONS_READ 'exceptions.read'            EXCEPTIONS_SIGN 'exceptions.sign'
AUDIT_VERIFY 'audit.verify'
```
Renamed: `USERS_MANAGE_EXECS 'users.manage_execs'` → `USERS_MANAGE_TEAM 'users.manage_team'` — "manage users who
share a team with you and whose resulting rights do not exceed yours" (containment, §3.4). Exported arrays:
`APPROVAL_CHECK_PERMISSIONS` (the five) and `APPROVAL_MAKE_PERMISSIONS`. `PERMISSION_INFO: Record<Permission,
{label, group, description}>` for the effective-permissions screen (every permission must have one; tested).

### 3.2 Presets (`packages/auth/src/roles.ts`)
`Role = TECH | HEAD | LEAD | SERVICE`, labels `Tech`, `Head`, `Lead`, `Service`.
- **SERVICE** = old CS_EXEC + `approvals.read`.
- **LEAD** = SERVICE + conversations.read_team, conversations.assign, customers.manage, agents.manage, agents.pause,
  prompts.edit, prompts.activate, agent_tools.manage, queues.manage, routers.read, routers.manage, escalation.manage,
  sla.manage, reviews.manage, corrections.manage, analytics.business.read, evaluations.run, message_templates.manage,
  alert_rules.business.manage, users.read, users.manage_team, audit.read, channels.read, mcp.read, providers.read,
  permissions.read.
- **HEAD** = LEAD + teams.manage, agents.delete, message_templates.delete, the five `approvals.check.*`,
  permissions.manage, exceptions.read, exceptions.sign.
- **TECH** = old PLATFORM_TECH_ADMIN (users.manage, audit.read_all, agents.read_all, …) + approvals.read,
  approvals.reassign_any, approvals.check.platform, approvals.check.permissions, permissions.read, permissions.manage,
  exceptions.read, audit.verify, routers.read. Still no conversation content, no prompts.edit, no business analytics.

Invariants (rbac.test.ts): every permission in ≥1 preset; presets grant only catalogued permissions; TECH lacks
conversation content, prompts.edit, analytics.business.read and the agents/routing/channels check permissions;
SERVICE and LEAD hold no check permission; HEAD holds all five.

### 3.3 Effective permissions
`Principal` gains `permissions: ReadonlySet<Permission>` (optional in the type for legacy constructors; when absent
`can()` falls back to the preset). `loadPrincipal` computes `preset ∪ activeGrants − activeRevokes` in the same round
trip as team membership. `GET /v1/auth/me` returns `principal.permissions` (not `permissionsForRole`). Grant changes
take effect on the next request; preset changes and deactivation still revoke sessions.

Table `user_permission_grants` (migration 0022):
```
id uuid PK (uuidv7) · user_id uuid NOT NULL → users · permission text NOT NULL · effect text NOT NULL CHECK IN ('GRANT','REVOKE')
expires_at timestamptz NULL · reason text NOT NULL · proposal_id uuid NULL (the approval that made a GRANT effective)
created_by uuid → users · created_at timestamptz · cleared_at timestamptz NULL · cleared_by uuid NULL
UNIQUE (user_id, permission) WHERE cleared_at IS NULL · INDEX (user_id) WHERE cleared_at IS NULL
```
Active = `cleared_at IS NULL AND (expires_at IS NULL OR expires_at > now())`. Expiry is computed, never swept.

### 3.4 Changing someone's rights
A change set (preset change, GRANT, REVOKE, CLEAR) is classified by comparing effective sets: **increase** if the new
set contains any permission the old set lacks, else **decrease**. Decreases apply immediately (audited
`user.permissions_reduced`). Increases become a `permission_change` proposal (user creation is kind `user`, action
CREATE; the user row exists with `status='PENDING_APPROVAL'`, cannot sign in, and the invite is sent on activation).
- Maker: `permissions.manage` (grants/revokes) or `users.manage` / `users.manage_team` (create, preset). Never self.
  With `users.manage_team` the target must share a team with the maker and the resulting set ⊆ maker's set.
- Checker for `user` / `permission_change`: `approvals.check.permissions`, shares a team with the target **or** holds
  `users.manage`; never the maker and never the target user.

### 3.5 API
- `GET /v1/permissions/catalogue` (Authenticated) → `[{permission,label,group,description,presets[]}]`.
- `GET /v1/users/:id/permissions` (`permissions.read`; target must share a team unless `users.manage`) →
  `{preset, effective:[{permission, sources:[{kind:'PRESET'|'GRANT', expiresAt, grantedBy, reason, proposalId}], revoked?:{...}}], overrides:[...]}`.
- `POST /v1/users/:id/permission-changes` (`permissions.manage` | `users.manage` | `users.manage_team`)
  `{preset?, changes:[{op:'GRANT'|'REVOKE'|'CLEAR', permission, expiresAt?}], reason, approval?:{checkerId}}` →
  200 `{applied:true}` for a decrease, 202 `{proposal}` for an increase (409 `approval_required` without `approval`).
- `POST /v1/users` gains `approval:{checkerId, reason}`; returns 202 `{user, proposal}`.
- `PATCH /v1/users/:id` preset changes route through the classification above.

### 3.6 UI
Team → user drawer gains a **Permissions** tab: effective permissions grouped by `PERMISSION_INFO.group`, a source chip
per row (Preset / Granted until 3 Oct / Revoked), and **Change permissions** (grant, revoke, clear, optional expiry,
reason; the checker picker appears only when the change is an increase). Users pending approval show a badge.

---

## 4. Maker–checker (areas APPROVALS-CORE, APPROVALS-COVERAGE)

The spine is `11b-approvals-detail.md` (tables `approval_proposals` + append-only `approval_decisions`, descriptor
registry, content + dependency hashes, deferred activation, bulk approve, checker sweep, grandfather migration).
Amendments in this document:

1. **Submission UX (Eng).** Every approvable write endpoint accepts `approval?: {checkerId, reason}`. When the write
   needs approval (object already approved, or action ACTIVATE/DELETE) it creates the proposal with the request body as
   payload and returns **202** `{proposal}`; without `approval` it returns **409 `approval_required`** with
   `{objectKind, action, objectId}`. Drafts (never approved) are written directly (200). `POST /v1/approvals` stays for
   kinds without their own write endpoint.
2. **Bootstrap (Decided).** Decision kind `BOOTSTRAP_APPROVE`; proposal column `bootstrap boolean`. Allowed only when
   `eligibleCheckers(proposal)` excluding the maker (and the target user for permission kinds) is empty **and** the maker
   holds the descriptor's `checkPermission`. The submit endpoint accepts `approval:{bootstrap:true}` in that case and
   approves immediately.
3. **Checker eligibility (Eng).** Descriptor `eligible(tx, checker, proposal)`; default: ACTIVE, holds the check
   permission, not the maker, and `proposal.team_ids = '{}'` or overlaps the checker's teams. Platform kinds
   (`team_ids='{}'`) accept any holder of the check permission.
4. **Kinds and check permissions:** agent, prompt_version, agent_tool_grant, escalation_rule, alert_rule(business) →
   `check.agents`; router, queue, sla_policy → `check.routing`; channel, message_template → `check.channels`;
   model_provider, model_profile, mcp_connection, notification_destination, webhook_subscription, alert_rule(technical),
   deployment_settings → `check.platform`; user, permission_change → `check.permissions`.
5. **Stop actions (never gated):** agent pause (`agents.pause`), channel disable, router disable, MCP connection disable,
   tool-grant removal, escalation-rule/alert-rule/webhook/destination disable, user disable, permission decreases.
   Resuming any of them is ACTIVATE.
6. Existing live configuration **and existing ACTIVE users** are grandfathered by migration 0027 (after routing).
7. Deferred activation: message templates (provider submission), MCP connection enable, user CREATE (invite email).

UI: `/approvals` (Awaiting me · Sent by me · All open (Tech) · Decided), drawer with diff, decision form, bulk bar,
reassign; `SubmitForApproval` modal and `PendingBadge` reused by every object screen; notices slot.

---

## 5. Routing (area ROUTING)

### 5.1 Data model (migrations 0024, 0025)
```
routers         id · name (unique ci) · description · status DRAFT|ACTIVE|DISABLED · active_version_id (app-validated)
                · created_by · created_at · updated_at
router_versions id · router_id → routers ON DELETE CASCADE · version int · definition jsonb · reason · created_by
                · created_at · UNIQUE(router_id, version) · immutable (trigger, like prompt_versions)
router_drafts   router_id PK → routers · definition jsonb · updated_by · updated_at
channels        + router_id uuid NULL → routers ON DELETE SET NULL
queues          + agent_id uuid NULL → virtual_agents ON DELETE SET NULL   (one agent per queue)
                + attributes jsonb NOT NULL DEFAULT '{}'  · UNIQUE (attributes) WHERE attributes <> '{}'
                + business_hours jsonb NULL · + transfer_target_ids uuid[] NOT NULL DEFAULT '{}'
conversations   agent_id → NULLABLE; CHECK (agent_id IS NOT NULL OR control_state = 'ROUTING');
                control_state CHECK gains 'ROUTING'; conversations_open_uq (customer, channel, agent) replaced by
                conversations_open_channel_uq (customer_id, channel_id) WHERE control_state <> 'RESOLVED'
conversation_routing
                conversation_id PK → conversations ON DELETE CASCADE · router_id · router_version_id
                · phase RETURNING|STEPS|DONE · step_index int · attributes jsonb · answers jsonb · classifications jsonb
                · follow_ups int · attempts int · previous_state text NULL · awaiting_since timestamptz NULL
                · outcome NULL|RULE|MODEL|FALLBACK|PASS_THROUGH|CONTINUE|TIMEOUT · rule_index int NULL · queue_id NULL
                · decided_at NULL · updated_at
interactions    actor_type gains 'ROUTER' (router questions; mapped to assistant turns with an "(automated menu)"
                marker in the compiled history)
```
`channels.default_agent_id` and `agent_channels` stay in the schema (deprecated, no longer read or written) and are
dropped in a later release.

### 5.2 Router definition (`packages/domain/src/routing/router-definition.ts`, zod, browser-safe)
```ts
type AttrKey = string                       // /^[a-z][a-z0-9_]{0,39}$/
interface MessageSpec { text: string; templates?: Record<string /*channelId*/, string /*message_templates.id*/> }
type RouterStep =
  | { id: string; kind: 'ASK'; attribute: AttrKey; prompt: MessageSpec;
      options: Array<{ value: string; label: string; synonyms?: string[] }>;   // 2..10
      maxAttempts: number /*1..5*/; skipIfKnown: boolean }
  | { id: string; kind: 'CLASSIFY'; attribute: AttrKey; modelProfileId: string; instructions: string;
      labels: Array<{ value: string; description: string }>;               // 2..20
      minConfidence: number /*0..1, 0.7*/; maxFollowUps: number /*0..3*/; skipIfKnown: boolean }
  | { id: string; kind: 'KNOWN'; attribute: AttrKey; from: 'customer.language' | `customer.attribute:${string}` }
interface RouterRule { when: Record<AttrKey, string | string[]>; queueId: string }   // all keys match; array = any of
interface RouterDefinition {
  steps: RouterStep[];                       // ≤ 10; [] = pass-through
  rules: RouterRule[];                       // ≤ 100, first match wins
  fallbackQueueId: string;                   // required
  returning: { askAfter: { value: number; unit: 'HOURS' | 'DAYS' | 'MONTHS' }; prompt: MessageSpec;
               continueLabel: string; newLabel: string } | null;
  timeoutMinutes: number;                    // 1..1440, default 10: no answer → fallback
}
```
Validation at activation: every referenced queue exists, is approved and has an agent; model profiles exist and are
approved; template ids belong to the channel they are keyed by; option values unique per step.

### 5.3 Engine
- **Ingress** (`IngressService.receive`) replaces agent resolution with `RoutingEngine.admit(tx, channel, customer,
  message)`. No active router → reject `no_router` (replaces `no_agent`, logged loudly as today).
- **Existing open conversation**: if ROUTING, append and enqueue `conversation.route`. Else, if the router has
  `returning` and `now − lastCustomerMessageAt ≥ askAfter`, move it to ROUTING/phase RETURNING (remember
  `previous_state`), send the continue/new prompt; else append as today.
- **Resolved conversation within the reopen window**: gap < askAfter → reopen silently as today; gap ≥ askAfter →
  reopen into ROUTING/RETURNING with `previous_state='RESOLVED'`.
- **No usable conversation**: pass-through (no steps) → decide immediately, create the conversation with queue +
  agent (AI_ACTIVE), exactly today's path. Otherwise create it in ROUTING with `agent_id NULL`, phase STEPS, and
  enqueue `conversation.route`.
- **`conversation.route` consumer** (worker, leased like turns) runs `RoutingEngine.advance`:
  RETURNING — match the reply against continue/new (label, number, synonyms `continue|new`); continue → restore
  (`previous_state`, a resolved one reopens) and publish `conversation.turn`; new → resolve the old conversation
  (disposition `CUSTOMER_STARTED_NEW`), create a new one carrying the triggering customer message(s) as copies
  (idempotency key suffixed `:carried`), phase STEPS; no match after 2 prompts → continue.
  STEPS — KNOWN sets the attribute if present; ASK sends a `CHOICES` part then matches the reply (label, option
  number, synonym, case-insensitive), re-asks up to `maxAttempts`, then leaves the attribute unset; CLASSIFY calls the
  profile's model with structured output `{label, confidence, followUp}` over the customer's messages, commits when
  `confidence ≥ minConfidence`, else asks `followUp` while `follow_ups < maxFollowUps`, else leaves it unset.
  Then rules (first match) or the fallback queue → `ROUTE_COMPLETE`: set `queue_id`, `agent_id = queue.agent_id`,
  `resolution_due_at`, AI_ACTIVE, timeline system event ("Routed to Tamil Sales — rule 2: language=ta,
  product=sales"), publish `conversation.turn`. The agent's compiled prompt gains a `routing` block (queue name +
  attributes).
- **Timeout** (leader task, 60 s): ROUTING with `awaiting_since` older than `timeoutMinutes` → fallback, outcome TIMEOUT.
- **Router messages** are OUTBOUND interactions with `actor_type='ROUTER'`, delivered through the channel adapter.
  Out of the session window, `MessageSpec.templates[channelId]` is sent if set; otherwise delivery fails with
  `session_window_closed` (an exception-report item).

### 5.4 Choices capability (channels plugin boundary)
`ChannelCapabilities.choices?: { buttons: number; list: number }`; new outbound part `CHOICES { text, options:[{id,
label}] }`. Adapters render natively when supported (Meta WhatsApp interactive buttons ≤3 / list ≤10; web chat widget
buttons), else through the shared `renderChoicesAsText` (numbered lines) in `@ocso/channels`. Inbound interactive
replies are normalised to TEXT carrying the option label. Core never names a kind.

### 5.5 Control states and transfers
- `ROUTING` added to `ControlState`; `inboundStartsAiTurn(ROUTING)=false`; `aiMaySendAutonomously` unchanged
  (router messages are written by the router writer, never the AI path).
- Commands: `ROUTE_START` (system: AI_ACTIVE|RESOLVED → ROUTING), `ROUTE_COMPLETE` (system: ROUTING → AI_ACTIVE),
  `ROUTE_CONTINUE` (system: ROUTING → previous state, RESOLVED reopens to AI_ACTIVE), `RESOLVE` from ROUTING
  (human/system). `TRANSFER_QUEUE` (agent actor: AI_ACTIVE → AI_ACTIVE; human: HUMAN_ACTIVE|WAITING_FOR_HUMAN keep state).
- `ControlPatch` gains `agentId`. Invariant becomes "exactly one agent at a time"; every turn records its agent.
- **Human transfer** (`transfer`): target queue with a different agent sets `agent_id` to it; SLA recomputed.
- **AI transfer**: first-party tool `ocso_transfer_to_queue {queue, reason, summary}` whose `queue` enum is the source
  queue's approved `transfer_target_ids` that have an agent; effect `{type:'transfer', queueId, summary}` handled in
  `TurnWriter.complete` → `TRANSFER_QUEUE`, a HANDOVER summary for the receiving agent, a timeline event, and a
  `conversation.turn` so the receiving agent continues immediately (it gets the handover even with no new customer
  message).
- Business hours: `humanAvailability` reads `queue.business_hours ?? agent.business_hours`.

### 5.6 Migration of existing data (0025)
For every agent reachable today (`channels.default_agent_id`, else the single `agent_channels` row): its service
queue is `agent.default_queue_id` if that queue has no agent yet, else a new queue named after the agent (suffix on
clash) whose `queue_teams` = the agent's owning teams; set `queues.agent_id`, copy `business_hours`. For every such
channel: a router named after the channel, ACTIVE, version 1 pass-through to that queue, `channels.router_id`. Open
conversations with `queue_id IS NULL` get their agent's service queue. Duplicate open conversations per
(customer, channel) — possible only if a channel's agent changed while one was open — keep the newest; older ones are
RESOLVED with disposition `SUPERSEDED_BY_ROUTING_MIGRATION`. Then the unique index swap. Live demo: channel
"WhatsApp — Twilio" → router "WhatsApp — Twilio" (pass-through) → queue "Maya" (agent Maya, Maya's teams) — no
behaviour change.

### 5.7 API and UI
`GET|POST /v1/routers`, `GET /v1/routers/:id`, `PUT /v1/routers/:id/draft`, `POST /v1/routers/:id/versions`
(freeze draft), `POST /v1/routers/:id/activate {versionId, approval}`, `POST /v1/routers/:id/disable`,
`PUT /v1/routers/:id/channels {channelIds, approval}`, `POST /v1/routers/:id/simulate {messages, answers}` → decision
trace. Reads `routers.read`, writes `routers.manage`. Queue PATCH accepts `attributes, agentId, businessHours,
transferTargetIds`. Conversation detail gains `routing`. Web: `/routers` list + `/routers/[id]` builder (steps,
rules, returning, fallback, timeout, per-message "Create template for <channel>" one-click, simulate panel); queue
dialog gains attributes/agent/hours/transfer targets; conversation right rail "Routing" card; transfer dialog shows
the receiving agent; agent Channels tab becomes a derived "Reached through" list; channel screen shows its router.

---

## 6. Audit store (area AUDIT)

### 6.1 Contract (new package `@ocso/audit-store`)
```ts
interface AuditRecord { id; occurredAt: Date; actorType; actorId|null; actorName|null; via; action; targetType;
  targetId|null; summary; before; after; correlationId|null; confirmation; ip|null; teamIds: readonly string[] }
type AuditScopeFilter = null | { actorId: string; teamIds: readonly string[]; sharedTargetTypes: readonly string[] }
interface AuditStoreQuery { targetType?; targetTypes?; targetId?; actorId?; via?; actionPrefix?; since?; until?;
  before?: { occurredAt: Date; id: string }; limit: number }
interface AuditStore {
  readonly driver: string;
  append(records: readonly AuditRecord[]): Promise<void>;          // idempotent on id
  has(ids: readonly string[]): Promise<ReadonlySet<string>>;        // reconciliation
  query(q: AuditStoreQuery, scope: AuditScopeFilter): Promise<AuditRecord[]>;   // (occurredAt,id) DESC keyset
  unsealed(limit: number): Promise<AuditRecord[]>;                  // not yet in the chain, oldest first
  chainHead(): Promise<ChainEntry | null>;
  appendChain(entries: readonly ChainEntry[]): Promise<void>;
  appendCheckpoint(c: Checkpoint): Promise<void>;
  checkpoints(q: { since?: Date; limit: number }): Promise<Checkpoint[]>;
  chainRange(fromPosition: number, limit: number): Promise<Array<{ entry: ChainEntry; record: AuditRecord | null }>>;
  purgeBefore(cutoff: Date): Promise<number>;                       // refuses anything younger than 365 days
  stats(): Promise<{ rows: number; bytes: number | null; oldest: Date | null; newest: Date | null }>;
  health(): Promise<{ ok: boolean; latencyMs: number; detail?: string }>;
  close(): Promise<void>;
}
interface ChainEntry { position: number; recordId: string; recordHash: string; prevHash: string; chainHash: string; sealedAt: Date }
interface Checkpoint { id: string; upToPosition: number; chainHash: string; createdAt: Date; keyId: string; signature: string }
interface AuditStoreDriverDefinition<Env> { name; check?(env): readonly string[]; create(env, deps: { logger }): AuditStore }
```
`recordHash = sha256(canonicalJson(record))`; `chainHash_n = sha256(prevHash_n ‖ recordHash_n)`, genesis prevHash
`'0'×64`. Checkpoint signature = Ed25519 over `ocso-audit-checkpoint\n<upToPosition>\n<chainHash>\n<createdAt ISO>`.

### 6.2 Main database (migration 0026)
`audit_events` gains `team_ids uuid[] NOT NULL DEFAULT '{}'`, `shipped_at`, `verified_at` (+ partial index on
unshipped). `recordAudit` stays same-transaction and fills `team_ids` = target's teams ∪ actor's teams via
`auditTeams(tx, targetType, targetId, actor)`. The immutability trigger function is replaced to allow exactly: UPDATE
that changes only `shipped_at`/`verified_at`; DELETE under the existing retention cutoff; DELETE of rows with
`verified_at` set, older than 30 days, when the transaction sets `ocso.audit_local_prune`. Backfill `team_ids` for
existing rows by target type. `deployment_settings.audit_local_window_days int NOT NULL DEFAULT 90 CHECK (≥30)`.
`audit_incidents (id, kind SHIP_FAILED|STORE_DOWN|RECONCILE_MISSING|CHAIN_BROKEN|EXPORT_FAILED, detail jsonb,
first_seen, last_seen, count, resolved_at)`.

### 6.3 Worker (leader tasks)
- `audit-ship` (2 s): 500 unshipped rows (oldest first) → `store.append` → set `shipped_at`. Failure → incident
  (upsert, count), backoff; OCSO keeps serving — the outbox is durable.
- `audit-reconcile` (5 min): shipped-unverified rows older than 30 s → `store.has` → `verified_at`; missing → clear
  `shipped_at`, incident RECONCILE_MISSING.
- `audit-seal` (10 s): `store.unsealed(1000)` → chain entries from the head → `appendChain`; checkpoint every 1 000
  entries or hourly, signed.
- `audit-export` (daily): sealed range since the last export → `audit-exports/YYYY/MM/DD/<from>-<to>.ndjson.gz` +
  signed manifest (records, chain entries, checkpoint, public key) via the BlobStore.
- Retention: local prune of verified rows beyond `audit_local_window_days`; `store.purgeBefore(max(cutoff, now−365d))`.

### 6.4 Reads
`queryAudit(store, db, q, scope)` = `store.query` merged with main-DB rows where `shipped_at IS NULL` (same filters
and scope), merged by `(occurredAt,id)` DESC — the audit screen never shows lag. `auditScope` now returns an
`AuditScopeFilter` (null for `audit.read_all`; else own actor id, own teams, shared target types). Analytics/home
readers that look at recent windows (execHome, promptVersionMarkers, system-overview, privilegedChanges) keep reading
the local window. Ask OCSO's `recent_changes` uses `queryAudit` with the caller's scope.

### 6.5 Drivers
- **postgres** — own database (`AUDIT_DATABASE_URL`, writer role). Schema (`packages/audit-store/migrations/postgres`):
  `audit_records` range-partitioned by month on `occurred_at` (PK `(id, occurred_at)`, `team_ids` GIN), `audit_chain`
  (position PK, record_id unique), `audit_checkpoints`; UPDATE/DELETE/TRUNCATE rejected by triggers; the writer role has
  INSERT/SELECT only plus EXECUTE on two SECURITY DEFINER functions: `audit_ensure_partitions(months_ahead)` and
  `audit_purge_before(cutoff)` (drops whole partitions older than `max(cutoff, now()−365 days)`).
- **clickhouse** — HTTP interface over the injected fetch (no SDK), JSONEachRow. `audit_records` ReplacingMergeTree
  partitioned `toYYYYMM(occurred_at)` ordered `(occurred_at, id)`, reads with `FINAL`; `audit_chain`,
  `audit_checkpoints` MergeTree; writer user granted SELECT, INSERT and `ALTER DROP PARTITION` on audit_records;
  365-day floor enforced by the driver.
- Provisioning bin `audit-migrate` (owner credentials, run by the migrate container): applies the driver's
  migrations, ensures the writer role/user with the password from a file, grants. `AUDIT_PROVISION_ROLE=false` for
  managed databases where the DBA created it. Verify bin `audit-verify [--from N] [--to N]`.
- Env (`@ocso/config` common): `AUDIT_DRIVER` (default `postgres`), `AUDIT_DATABASE_URL`(+`_FILE`),
  `AUDIT_DATABASE_SSL`, `AUDIT_DATABASE_POOL_SIZE` (5), `CLICKHOUSE_URL`, `CLICKHOUSE_DATABASE` (`ocso_audit`),
  `CLICKHOUSE_USER`, `CLICKHOUSE_PASSWORD`(+`_FILE`), `AUDIT_SIGNING_KEY_FILE`; migrate-only
  `AUDIT_DATABASE_OWNER_URL`(+`_FILE`), `AUDIT_WRITER_PASSWORD`(+`_FILE`), `CLICKHOUSE_ADMIN_USER`,
  `CLICKHOUSE_ADMIN_PASSWORD`(+`_FILE`).
- Compose: `audit-db` service (postgres, volume `auditdata`, secrets subpath `audit-postgres`), keygen generates the
  audit owner password, writer password, writer URL, owner URL and the Ed25519 audit signing key; the migrate step
  also runs `audit-migrate`; entrypoint allowlist extended. Terraform keeps parity (env + secrets).
- Health: readiness does NOT depend on the audit store; `dependencies()` reports it with lag. System screen: audit
  store panel (driver, status, lag, unshipped, sealed position, last checkpoint, exports, verify recent range).

### 6.6 What changes in the guarantee (for the ADR)
Before: audit row and change commit together in one database. Now: they still do (the outbox row); the *store* copy
arrives within seconds, at least once, idempotently, and no outbox row is pruned until reconciliation proves it is in
the store. Lost: the store is not transactionally atomic with the change. Compensated: outbox atomicity +
reconciliation + lag/gap incidents in the exception report + the merged read path.

---

## 7. Exceptions and storage (area EXCEPTIONS)

`exception_reports (id, kind WEEKLY|ADHOC, period_start, period_end, status DRAFT|SIGNED, content jsonb, content_hash,
generated_at, generated_by NULL=scheduler, signed_at, signed_by, sign_note, signature, key_id)`; UNIQUE (kind,
period_start) WHERE kind='WEEKLY'; UPDATE rejected once SIGNED, DELETE rejected (triggers).
Kinds (registry `EXCEPTION_KINDS`, each `{id,label,severity,compute(ctx)}` → items `{objectKind, objectId, title,
detail, occurredAt, href}`): `live_without_approval` (descriptor `liveObjects()` minus approved),
`bootstrap_approvals`, `approvals_aged` (`approval_age_warning_hours`), `resubmitted_unchanged`, `permission_bypass`
(active GRANT with no proposal), `routing_fallback` (FALLBACK/TIMEOUT), `templates_rejected`, `delivery_failures`,
`audit_shipping` (incidents + current lag), `audit_chain` (CHAIN_BROKEN). Live view computed on read; the weekly report
(leader task, deployment timezone, Monday) freezes it as DRAFT; a holder of `exceptions.sign` signs (Ed25519 with the
audit signing key over `ocso-exception-report\n<id>\n<period>\n<content_hash>\n<signed_by>\n<signed_at>`); signing is
audited; export JSON/CSV bundle with signature, public key and verification instructions.
Storage: `storage_samples (day, table_name, rows, bytes)` daily; `GET /v1/system/storage` with growth and the
ClickHouse guidance; `health_sample_rollups` (hourly) with raw health samples kept 2 days.
UI: `/exceptions` (live · weekly reports · sign · export) behind `exceptions.read`; System → Storage panel.

---

## 8. Migrations (main database) and owners

| # | File | Owner |
|---|---|---|
| 0021 | `roles_rename` — role values, CHECK, alert audiences, tool human roles, auth policy MFA roles | wave 0 |
| 0022 | `permission_grants` — `user_permission_grants`, users `PENDING_APPROVAL` status | PERMS |
| 0023 | `approvals` — proposals, decisions (append-only), settings column | APPROVALS-CORE |
| 0024 | `routing` — routers, versions, drafts, queue columns, conversation changes, conversation_routing | ROUTING |
| 0025 | `routing_backfill` — service queues, pass-through routers, dedupe, unique index swap | ROUTING |
| 0026 | `audit_outbox` — audit_events columns + trigger, incidents, settings column, team_ids backfill | AUDIT |
| 0027 | `approvals_coverage_business` — any columns the business/identity descriptors need | COVERAGE-BUSINESS |
| 0028 | `exceptions_storage` — reports, storage samples, health rollups | EXCEPTIONS |
| 0029 | `approvals_coverage_platform` — any columns the platform descriptors need | COVERAGE-PLATFORM |
| 0030 | `routing_web` — any columns the router/queue descriptors need | ROUTING-WEB |
| 0031 | `approvals_grandfather` — MIGRATION proposals for every live object and ACTIVE user (last, so every kind exists) | integrator |

Stubs exist from wave 0; owners fill their file by hand (never run `drizzle-kit generate`). The integrator refreshes
drizzle snapshots at the end.

---

## 9. Build waves and ownership

- **Wave 0 (integrator):** role rename everywhere, permission catalogue + presets + `PERMISSION_INFO`,
  `Principal.permissions`, `/v1/auth/me`, migration 0021, migration stubs 0022–0028, approval contract skeleton
  (`packages/domain/src/approvals/*` types, `packages/application/src/approvals/contract.ts` + `registry.ts`).
- **Wave 1 (parallel):** PERMS, APPROVALS-CORE, ROUTING, AUDIT.
- **Wave 2 (parallel):** COVERAGE-BUSINESS (agent tool grants, escalation rules, business alert rules, message
  templates, users, permission changes), COVERAGE-PLATFORM (channels, model providers/profiles, MCP connections,
  notification destinations, webhooks, technical alert rules, deployment settings), ROUTING-WEB (router/queue/SLA
  descriptors + the router builder and routing UI), EXCEPTIONS. The integrator writes 0031 (grandfather) last, guarded
  by a test that a migrated database has no live object without an approval.
- **Wave 3:** integration, drizzle snapshot refresh, full verification (typecheck, lint, unit, integration, every
  Playwright spec, chaos), adversarial review, fixes, ADRs 029–033, README/docs, PR.

Shared files are append-only edits by every area (re-read immediately before editing): `packages/db/src/schema/index.ts`,
`packages/events/src/catalogue.ts`, `apps/web/lib/nav.ts`, `apps/web/lib/realtime/events.ts`,
`apps/worker/src/scheduler/tasks.registry.ts`, `apps/worker/src/consumers/consumers.service.ts`,
`apps/api/src/app.module.ts`, `packages/application/src/index.ts`.
