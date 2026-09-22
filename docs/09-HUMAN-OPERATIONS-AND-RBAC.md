# Human Operations and RBAC

## 1. Roles

OCSO has three primary human user types.

### Platform Tech Admin
Technical platform ownership.

### CS Lead
Business/customer-operations ownership.

### CS Exec
Frontline human conversation handling.

Avoid multiplying roles until concrete authorization needs require it.

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

Tech Admin:
- provider configuration
- worker/scaling config
- technical logs/traces
- MCP technical setup
- system alerts
- security configuration

CS Lead:
- virtual-agent business prompt/instructions
- queue/routing policy
- escalation policy
- QA
- business analytics
- prompt corrections
- business alerts
- team management subject to policy

CS Exec:
- conversation handling
- claim/accept
- customer reply
- internal note
- approved tools
- resolve
- return-to-AI

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

- Roles map to permission sets in `packages/auth/src/roles.ts`; every API route declares its permission (checked by a unit test) and conversation-scoped routes also check conversation access. The web navigation is derived from permissions, never role names.
- Copilot: drafts for the human handling a conversation, on request or proactively when a customer writes while `HUMAN_ACTIVE`; never sent automatically; policy identifiers are shown only if they exist in the agent's active prompt.
- Team management is a CS Lead capability (§6); the Tech Admin manages users and system settings.
- WhatsApp after 24 hours (§4, docs/07 §3). The composer shows the reply window on WhatsApp conversations ("reply window open · closes in 3h 12m"). Once it has closed (24 hours after the customer's last message on that number), **Reply to customer** gives way to **Template**: the exec picks an approved template of the conversation's channel (search, category badge, language), fills every variable (examples as placeholders), checks the live preview — exactly the text the customer receives — and sends. Templates are also available while the window is open (structured notifications). The same holder rule as a reply applies (HUMAN_ACTIVE; the assigned human, or a lead with assign rights); a free-form reply after the window is refused with `session_window_closed` before anything is sent. The timeline and customer history show the filled text with the template's name, language and category; the send is audited (`conversation.template_sent`, with which variables were filled but not their values).
- A **resolved** WhatsApp conversation offers **Reopen with a template**: staff may reopen conversations (REOPEN by a human → HUMAN_ACTIVE with them as the handler, `conversations.take_over`), so reopen-and-send is one action (`reopen: true`) — refused when the customer already has a newer open conversation with the same agent on that channel. Without `reopen` the API asks for an explicit reopen first.
- Templates are business content: `whatsapp_templates.manage` (CS Lead, for channels used by their teams' agents; Tech Admin, every channel) creates them in OCSO (**WhatsApp templates**) and submits them for WhatsApp approval, and deletes them; CS Execs cannot. The submitter gets an in-app notice when WhatsApp approves, rejects (with the reason), pauses or disables a template.
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
