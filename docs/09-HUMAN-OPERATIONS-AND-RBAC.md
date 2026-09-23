# Human Operations and RBAC

## 1. Presets and per-user permissions

OCSO has four presets (PM/research/11 §3). A preset is a starting set of permissions, not a level: every rule —
including who may approve whose work — is written in permissions (`packages/auth/src/permissions.ts`), and
`packages/auth/src/permission-info.ts` gives each one a label, a group and a description (the catalogue).

### Tech
Platform ownership: providers, channels, MCP, secrets, webhooks, system and deployment settings, every user
(`users.manage`), the whole audit log, platform and access approvals. Deliberately no conversation content, no
prompt editing, no business analytics, and no approval of agent, routing or channel changes.

### Head
Full authority inside the teams they belong to: everything a Lead holds, plus teams, deleting agents and templates
(through approval), all five `approvals.check.*` permissions, `permissions.manage`, and the exception report.

### Lead
Runs their teams: drafts and proposes configuration (agents, prompts, tools, queues, routers, templates, business
alerts), pauses agents, manages colleagues who share a team and whose rights fit inside their own
(`users.manage_team`). Checks nobody's work.

### Service
Frontline conversation handling in their teams' queues, plus reading the approvals they are part of.

Existing users were mapped by migration 0021: Platform Tech Admin → Tech, CS Lead → Head, CS Exec → Service.

### Per-user permissions

A user's effective permissions are **preset ∪ active grants − active revokes** (`user_permission_grants`, migration
0022). A grant may expire; expiry is computed on every request, never swept. One live override per permission. The
table is its own history: a trigger lets a row change only by being cleared once, rows are never deleted, and users
with grant history cannot be deleted (`ON DELETE RESTRICT`). `loadPrincipal` computes the set together with the user's
teams in one query, so a change takes effect on the next request; a preset change or deactivation also ends every
session at once, and open streams (staff SSE, Ask OCSO) re-check the user's rights every minute and close when they
lost a permission or a team (a revoke, an expired grant, a team removal). `GET /v1/auth/me` returns the effective set.
Effective permissions, not presets, also decide handoff routing (who can be assigned needs `conversations.read` and
`conversations.reply` now), the MCP OAuth callback, and MFA: when "require MFA for roles" lists a preset, anyone
granted a permission that preset holds and their own lacks must use a second factor too.

Everyone — Head included — acts only inside the teams they belong to.

**Tech never holds conversation content** (conversations, customers, human tools, Copilot, reviews, corrections),
`prompts.edit` or business analytics — not even through an approved grant (`NON_GRANTABLE_BY_PRESET` in `@ocso/auth`;
400 `grant_not_allowed_for_preset`, re-checked when an approval applies, and a preset change to Tech cannot carry
such a grant along).

**Increase vs decrease.** `planRightsChange` in `@ocso/auth` splits a change set (preset, status, memberships,
grants, revokes, clears) into what only takes access away — a revoke, clearing a grant, shortening a grant, leaving a
team, a downgrade to a preset contained in the old one, disabling — and the rest. The reductions **apply at once,
even when the same request also widens access**; the rest is an **increase** when the user would hold a permission
they lack, join a team, hold a grant that is new or lasts longer, or become active.
- Reductions are audited `user.permissions_reduced` (disabling: `user.disable`; team removal from the team drawer:
  `team.member_remove`). Stopping is never held for approval.
- Increases never apply directly. They are proposals for a checker holding `approvals.check.permissions`
  (kinds `user` and `permission_change`); without a named checker the API answers **409 `approval_required`**
  with `{objectKind, action, objectId}` — and, when the request also carried reductions, says they were applied
  (`details.applied`). The checker is never the maker nor the target (400 `checker_not_eligible`). (Until the approval
  spine's `user` and `permission_change` descriptors are registered, naming a checker gets the same 409.) Approval runs
  `activateUser` / `applyPermissionChangeSet` (`packages/application/src/identity/permissions/apply.ts`), which
  re-check the maker's rights at that moment (`maker_not_active`, `maker_no_longer_eligible`), record the maker as the
  grant's `created_by`, and are audited `user.activate` / `user.enable` / `user.permissions_increased`.
- A new user is created **PENDING_APPROVAL**: inert, unable to sign in (password: 403 `ACCOUNT_PENDING_APPROVAL`;
  SSO: `account_pending_approval`); the invite is sent when their creation is approved. A pending user is a draft:
  preset and teams are edited directly (grants still need approval). `PATCH /v1/users/:id` with `approval` (or
  `status: 'ACTIVE'`) submits their creation; the `user` proposal binds the rights it approves (`{userId, makerId,
  rights}`), and activation refuses any other state (`user_changed_since_proposal`). A pending user cannot be disabled;
  it can be **discarded** (`DELETE /v1/users/:id`, pending only), which frees the email. If `POST /v1/users` names a
  checker and the proposal cannot be submitted, nothing is left behind.
- An approved user stays governed while **disabled**: an upgrade or a team added while disabled is an increase, and
  re-enabling is a `user` ACTIVATE proposal bound to the rights it restores (re-enabling goes alone: `activate_alone`).
- **SSO auto-provisioning** creates the new Service member PENDING_APPROVAL (audited `user.create`, `provisionedBy:
  'sso'`) and refuses that sign-in; once approved, the next SSO sign-in links them.

**Makers.** Grants and revokes need `permissions.manage`; creating users, presets and memberships need `users.manage`
or `users.manage_team`. Never on yourself (you may leave your own teams; nobody adds themselves to a team). Without
`users.manage` the target must share a team with you (before or after the change), a new user must be placed in one
of your teams, memberships change only on your teams, and the target's rights before and after must fit inside your
own (containment). All of this is decided under the target user's row lock. The creator of a new team joins it
without approval: a new team owns nothing yet, so joining it widens nobody's reach. The last active Tech admin with
password sign-in and `users.manage` cannot be downgraded, disabled or have `users.manage` revoked (break-glass).

**Development deployments** may set `OCSO_DEV_SKIP_ACCESS_APPROVAL=true` (refused when `NODE_ENV=production`, and
accepted only when `NODE_ENV` is set explicitly to `development` or `test`; the API logs a warning at start-up): users
are created active and preset upgrades, re-enabling and team additions apply at once — the e2e stack and the API
integration harness use it. Grants still need approval. The demo seed creates its people active the same way. Every
skipped approval is audited with `approvalSkipped: 'dev_flag' | 'demo_seed'` so the exception report can list it.

**Screens.** Team → a person's name opens their drawer; the **Permissions** tab lists the effective permissions
grouped by catalogue group with a source chip (preset / granted until … / revoked) and **Change permissions** (grant,
revoke, clear; optional expiry; reason). The dialog says what applies at once and what needs approval. Users waiting
for approval carry a *pending approval* badge, and their drawer offers **Discard**.

API: `GET /v1/permissions/catalogue` (any signed-in user), `GET /v1/users/:id/permissions` (`permissions.read`;
another user must share a team unless you hold `users.manage`, else 404), `POST /v1/users/:id/permission-changes`
(200 `{applied, lost, teamsRemoved, sessionsEnded}` · 202 with `proposal`, `gained`, `teamsAdded` · 409
`approval_required`), `POST /v1/users` (201 pending, 202 with a proposal), `PATCH /v1/users/:id` and
`POST /v1/teams/:id/members` (increases 409 / 202), `DELETE /v1/users/:id` (pending users only, 204).

## 2. CS inbox

CS Execs should be able to see all conversations they are authorized to access, including:
- AI-active conversations where visibility policy allows
- waiting-for-human conversations
- open pickup queue
- assigned conversations
- priority conversations
- recently resolved conversations

The default product should make it easy for an eligible rep to inspect and pick up work.

## 3. Handoff

Two primary modes:
- AUTO_ASSIGN
- OPEN_PICKUP

Assignment strategy can consider:
- availability
- active workload
- team
- skill
- language
- account ownership
- priority
- configured routing rules

## 4. Human control

When a CS Exec takes control:
- control mode becomes HUMAN_ACTIVE
- AI stops sending autonomous customer-facing responses
- agent remains attached to the conversation
- full shared history remains available
- optional AI copilot assistance may be provided
- human may return control to AI

Every control transition is audited.

## 5. Internal notes

Internal notes are never rendered to customer channels and must be represented separately from customer-visible interactions.

## 6. Permission examples

Tech:
- provider, model profile and channel configuration
- worker/scaling config, technical logs/traces, system alerts
- MCP technical setup, secrets, webhooks, security configuration
- every user and permission change (proposes; checks platform and access changes)

Head (in their teams):
- everything a Lead does
- teams; deleting agents and templates (through approval)
- checking (approving) agent, routing, channel, platform and access changes
- per-user grants and revokes; the exception report

Lead (in their teams):
- virtual-agent business prompt/instructions, tools, escalation, pausing agents
- queue/routing policy, SLA, message templates, business alerts
- QA, business analytics, prompt corrections
- colleagues who share a team and whose rights fit inside their own

Service:
- conversation handling: claim/accept, customer reply, internal note, approved tools, resolve, return-to-AI

## 7. Prompt correction workflow

CS Leads need a productized way to identify bad behavior and improve instructions.

A correction should ideally capture:
- source conversation/turn
- observed problem
- desired behavior
- prompt component changed
- new prompt version
- author/time
- optional evaluation before activation

Do not mutate prompts invisibly.

## Implementation notes (as built)

- Presets map to permission sets in `packages/auth/src/roles.ts`, adjusted per user (§1); every API route declares its permission (checked by a unit test) and conversation-scoped routes also check conversation access. The web navigation is derived from the effective permissions, never preset names.
- Copilot: drafts for the human handling a conversation, on request or proactively when a customer writes while `HUMAN_ACTIVE`; never sent automatically; policy identifiers are shown only if they exist in the agent's active prompt.
- Team management is a Head capability (`teams.manage`, §6); the Tech manages every user and system settings; Leads and Heads manage colleagues within their teams and rights (§1).
- WhatsApp after 24 hours (§4, docs/07 §3). The composer shows the reply window on WhatsApp conversations ("reply window open · closes in 3h 12m"). Once it has closed (24 hours after the customer's last message on that number), **Reply to customer** gives way to **Template**: the exec picks an approved template of the conversation's channel (search, category badge, language), fills every variable (examples as placeholders), checks the live preview — exactly the text the customer receives — and sends. Templates are also available while the window is open (structured notifications). The same holder rule as a reply applies (HUMAN_ACTIVE; the assigned human, or a lead with assign rights); a free-form reply after the window is refused with `session_window_closed` before anything is sent. The timeline and customer history show the filled text with the template's name, language and category; the send is audited (`conversation.template_sent`, with which variables were filled but not their values).
- A **resolved** WhatsApp conversation offers **Reopen with a template**: staff may reopen conversations (REOPEN by a human → HUMAN_ACTIVE with them as the handler, `conversations.take_over`), so reopen-and-send is one action (`reopen: true`) — refused when the customer already has a newer open conversation with the same agent on that channel. Without `reopen` the API asks for an explicit reopen first.
- Templates are business content: `message_templates.manage` (CS Lead, for channels used by their teams' agents; Tech Admin, every channel) creates them in OCSO (**Message templates**, for channels whose adapter supports templates, e.g. WhatsApp) and submits them to the provider for approval, and deletes them; CS Execs cannot. The submitter gets an in-app notice when the provider approves, rejects (with the reason), pauses or disables a template.
- **Team-scoped virtual agents (ADR-026).** Agents are owned by teams (`agent_teams`); "CS Lead: virtual-agent business prompt/instructions" (§6) means *the agents their teams own*. Rules, enforced in the application services (`packages/application/src/agents/access.ts`, `owners.ts`), not only the UI:
  - A CS Lead reads and manages an agent only as a member of one of its owning teams — settings, status, prompts (draft, versions, diff, preview, activate), escalation rules, tool grants, analytics, reviews, corrections, evaluations and agent-scoped alerts and alert rules. Any other agent answers **404** (never 403), so its existence does not leak.
  - Creating an agent requires at least one owning team, all of them the creating lead's teams. A lead may add or remove only their own teams as owners; other teams' ownership is untouched; at least one owning team always remains. Removing every one of their own teams (a hand-off) is allowed while another team still owns the agent — the lead then loses access.
  - The Platform Tech Admin reads every agent (`agents.read_all`, technical fields) and reassigns owning teams across teams (`agents.assign_owner`, `PUT /v1/agents/:id/owners`, audited as `agent.owners_change`) — e.g. when a lead leaves. The Tech Admin still cannot edit prompts, tools or go-live.
  - A CS Exec reads (never manages) agents owned by their teams or reachable through their teams' queues (default queue, or an escalation rule targets the queue), for display in the workspace.
  - Conversations: `conversations.read_team` (replaces `conversations.read_all`, which no longer meant "all") lets a lead see conversations assigned to them, of agents their teams own, or routed to queues their teams serve — in any state. The exec scope (`conversations.read`) is unchanged. Inbox, detail, timeline, actions, customers (visible iff a visible conversation), tag suggestions, CSAT, copilot, Ask OCSO tools and the realtime stream all use the same predicate.
  - Alerts about an agent (`context.agentId`) are visible only to people who can read that agent; alerts about no agent stay visible to their audience. A platform-wide alert rule (agentId null) is visible to every lead; a rule targeting an agent only to that agent's leads.
  - Platform-wide escalation rules (agentId null) are listed with every agent and are read-only through the agent routes. Channels' default agent stays a Tech Admin setting (`channels.manage`); a lead links channels to their own agents from the agent (Channels tab).
  - Existing agents were given the teams serving their default queue as owners by the migration; agents with no such team are unowned (Tech Admin only) until assigned. A lead in no team manages no agent: the web shows "Join or create a team to create agents".
  - Known gap: the audit log (`audit.read`) is not team-scoped; a lead can read other teams' agent change summaries there.
- Business hours (per virtual agent, `virtual_agents.business_hours` = `{ timezone, humanHours: { mon: ['08:00','23:00'], … } }`, empty = humans 24×7; edited on the agent Settings tab, validated and audited by the API): the AI answers 24×7; the hours only govern humans. A handoff requested outside them still routes to its queue and is visible for pickup, but AUTO_ASSIGN offers (and OPEN_PICKUP auto-assign-after) wait for the next opening, the pickup SLA (`slaDueAt`) starts at the next opening, and the customer-facing handoff reply adds when the team is next available in the agent's time zone. Local times follow the IANA zone including DST (`packages/domain` business-hours helpers).
