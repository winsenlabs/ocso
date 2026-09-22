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
- Business hours (per virtual agent, `virtual_agents.business_hours` = `{ timezone, humanHours: { mon: ['08:00','23:00'], … } }`, empty = humans 24×7; edited on the agent Settings tab, validated and audited by the API): the AI answers 24×7; the hours only govern humans. A handoff requested outside them still routes to its queue and is visible for pickup, but AUTO_ASSIGN offers (and OPEN_PICKUP auto-assign-after) wait for the next opening, the pickup SLA (`slaDueAt`) starts at the next opening, and the customer-facing handoff reply adds when the team is next available in the agent's time zone. Local times follow the IANA zone including DST (`packages/domain` business-hours helpers).
