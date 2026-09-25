# Permissions reference

The full permission catalogue and what each of the four presets (Tech, Head, Lead, Service) holds by default. This
page is for Tech and Head users who manage access, and for contributors who add a permission. For how presets,
teams and maker–checker fit together, read [governance](../concepts/governance.md).

The source of truth is [`packages/auth`](../../packages/auth/src): permission names in
[`permissions.ts`](../../packages/auth/src/permissions.ts), labels and groups in
[`permission-info.ts`](../../packages/auth/src/permission-info.ts), presets in
[`roles.ts`](../../packages/auth/src/roles.ts) and the grant limits in
[`rights-plan.ts`](../../packages/auth/src/rights-plan.ts). The matrix below was generated from the built package
(see [Regenerating this page](#regenerating-this-page)), not typed by hand.

![The effective-permissions screen for one user](../assets/screens/permissions.webp)

## How rights are computed

- Every user has one **preset**: `TECH`, `HEAD`, `LEAD` or `SERVICE` (labels Tech, Head, Lead, Service). The
  preset gives the default permissions in the matrix below.
- **Per-user grants and revokes** adjust that set (`user_permission_grants`). Revokes and other reductions apply at
  once. Grants, preset upgrades and other widenings are proposals that a holder of `approvals.check.permissions`
  approves. `OCSO_DEV_SKIP_ACCESS_APPROVAL` never skips approval of per-user grants.
- Everything stays **scoped to the user's teams**: holding `conversations.read_team` means the conversations of
  *your teams'* agents and queues, not every conversation.
- Some permissions can **never** be granted to a preset, whatever the approval (next section).
- Authorization is checked in code on every request. Every api route declares `@RequirePermission`,
  `@RequireAnyPermission`, `@Authenticated` or `@Public`; a route without one is refused.

## Counts

76 permissions in 12 groups. Presets hold: Tech 38, Head 56, Lead 45, Service 19. Head holds everything Lead holds,
and Lead everything Service holds; Tech is a separate set.

## The matrix

`Yes` = held by the preset. `—` = not held, can be granted per user (through approval). `Never` = in
`NON_GRANTABLE_BY_PRESET` for that preset: it cannot be granted at all.

### Conversations

| Permission | Label | What it allows | Tech | Head | Lead | Service |
|---|---|---|:-:|:-:|:-:|:-:|
| `conversations.read` | Read own conversations | Conversations assigned to you or waiting in queues your teams serve. | Never | Yes | Yes | Yes |
| `conversations.read_team` | Oversee team conversations | Every conversation of your teams' agents and queues, whatever its state or assignee. | Never | Yes | Yes | — |
| `conversations.claim` | Claim conversations | Take a waiting conversation from a queue your teams serve. | Never | Yes | Yes | Yes |
| `conversations.take_over` | Take over from the AI | Stop the AI agent and answer the customer yourself. | Never | Yes | Yes | Yes |
| `conversations.reply` | Reply to customers | Send messages to customers in conversations you handle. | Never | Yes | Yes | Yes |
| `conversations.note` | Write internal notes | Add notes that only colleagues see. | Never | Yes | Yes | Yes |
| `conversations.return_to_ai` | Return to the AI | Hand a conversation you handle back to its AI agent. | Never | Yes | Yes | Yes |
| `conversations.resolve` | Resolve conversations | Close a conversation with a disposition. | Never | Yes | Yes | Yes |
| `conversations.transfer` | Transfer conversations | Move a conversation you handle to another queue. | Never | Yes | Yes | Yes |
| `conversations.assign` | Assign conversations | Assign a conversation to a colleague. | Never | Yes | Yes | — |
| `tools.execute_human` | Run tools | Run an agent's business tools yourself while handling a conversation. | Never | Yes | Yes | Yes |
| `tools.confirm_sensitive` | Confirm sensitive tool calls | Approve a sensitive action the AI agent asked to take. | Never | Yes | Yes | Yes |
| `copilot.use` | Use the reply copilot | Get suggested replies while handling a conversation. | Never | Yes | Yes | Yes |

### Customers

| Permission | Label | What it allows | Tech | Head | Lead | Service |
|---|---|---|:-:|:-:|:-:|:-:|
| `customers.read` | Read customers | Customer profiles of the conversations you can see. | Never | Yes | Yes | Yes |
| `customers.manage` | Edit customers | Change customer profiles and attributes. | Never | Yes | Yes | — |

### Agents

| Permission | Label | What it allows | Tech | Head | Lead | Service |
|---|---|---|:-:|:-:|:-:|:-:|
| `agents.read` | Read agents | Virtual agents your teams own, or reach through your teams' queues. | Yes | Yes | Yes | Yes |
| `agents.read_all` | Read every agent | Every virtual agent, whichever team owns it (technical fields; no transcripts). | Yes | — | — | — |
| `agents.manage` | Manage agents | Create agents and change the agents your teams own. Taking one live needs approval. | — | Yes | Yes | — |
| `agents.pause` | Pause agents | Pause an agent your teams own. Immediate; resuming needs approval. | — | Yes | Yes | — |
| `agents.delete` | Delete agents | Propose deleting an agent your teams own (through approval). | — | Yes | — | — |
| `agents.assign_owner` | Reassign agent owners | Change any agent's owning teams, e.g. when a lead leaves. | Yes | — | — | — |
| `prompts.edit` | Edit prompts | Draft prompt versions for agents your teams own. | Never | Yes | Yes | — |
| `prompts.activate` | Activate prompts | Propose making a prompt version the live one. | — | Yes | Yes | — |
| `agent_tools.manage` | Manage agent tools | Choose which tools an agent your teams own may call. | — | Yes | Yes | — |
| `escalation.manage` | Manage escalation rules | When and where an agent hands a conversation to people. | — | Yes | Yes | — |

### Routing and queues

| Permission | Label | What it allows | Tech | Head | Lead | Service |
|---|---|---|:-:|:-:|:-:|:-:|
| `queues.read` | Read queues | Queues, their teams and their live counts. | Yes | Yes | Yes | Yes |
| `queues.manage` | Manage queues | Create and change queues (changes to approved queues need approval). | — | Yes | Yes | — |
| `sla.manage` | Manage SLAs | Response and resolution targets. | — | Yes | Yes | — |
| `routers.read` | Read routers | How each channel routes conversations to queues. | Yes | Yes | Yes | — |
| `routers.manage` | Manage routers | Build routers and propose activating them. | — | Yes | Yes | — |

### Quality

| Permission | Label | What it allows | Tech | Head | Lead | Service |
|---|---|---|:-:|:-:|:-:|:-:|
| `reviews.manage` | Review conversations | Score and review conversations of your teams. | Never | Yes | Yes | — |
| `corrections.manage` | Manage corrections | Record and apply corrections to agents' answers. | Never | Yes | Yes | — |
| `analytics.business.read` | Business analytics | Volumes, outcomes and quality of your teams’ conversations. | Never | Yes | Yes | — |
| `evaluations.run` | Run evaluations | Test agents against evaluation sets. | — | Yes | Yes | — |

### Channels and templates

| Permission | Label | What it allows | Tech | Head | Lead | Service |
|---|---|---|:-:|:-:|:-:|:-:|
| `message_templates.manage` | Manage message templates | Draft templates and propose submitting them to the provider. | Yes | Yes | Yes | — |
| `message_templates.delete` | Delete message templates | Propose deleting a template (through approval). | — | Yes | — | — |
| `channels.read` | Read channels | Channels customers reach the deployment through. | Yes | Yes | Yes | — |
| `channels.manage` | Manage channels | Connect channels and propose activating them. | Yes | — | — | — |

### Platform

| Permission | Label | What it allows | Tech | Head | Lead | Service |
|---|---|---|:-:|:-:|:-:|:-:|
| `system.read` | Read system status | Health, workers and deployment facts. | Yes | — | — | — |
| `system.configure` | Configure the system | Worker scaling, retention and other platform settings. | Yes | — | — | — |
| `providers.read` | Read model providers | Model providers and profiles (never their keys). | Yes | Yes | Yes | — |
| `providers.manage` | Manage model providers | Connect model providers (changes need approval). | Yes | — | — | — |
| `model_profiles.manage` | Manage model profiles | Which model and settings agents use (changes need approval). | Yes | — | — | — |
| `mcp.read` | Read MCP connections | Tool servers and their tools. | Yes | Yes | Yes | — |
| `mcp.manage` | Manage MCP connections | Connect tool servers (enabling one needs approval). | Yes | — | — | — |
| `mcp.connect_personal` | Personal MCP sign-in | Sign in to tool servers that act as you. | Yes | Yes | Yes | Yes |
| `secrets.manage` | Manage secrets | Store and rotate credentials (values are never shown back). | Yes | — | — | — |
| `webhooks.manage` | Manage webhooks | Outbound event subscriptions. | Yes | — | — | — |
| `telemetry.technical.read` | Technical telemetry | Traces, latency and usage (no transcript text). | Yes | — | — | — |
| `pricing.manage` | Manage pricing | Model prices used for cost reporting. | Yes | — | — | — |
| `deployment_settings.manage` | Deployment settings | Organisation name, timezone, residency and sign-in policy. | Yes | — | — | — |

### Alerts

| Permission | Label | What it allows | Tech | Head | Lead | Service |
|---|---|---|:-:|:-:|:-:|:-:|
| `alerts.technical.read` | Technical alerts | Alerts about the platform. | Yes | — | — | — |
| `alerts.business.read` | Business alerts | Alerts about conversations, queues and agents you can see. | — | Yes | Yes | Yes |
| `alerts.acknowledge` | Acknowledge alerts | Acknowledge and resolve alerts you can see. | Yes | Yes | Yes | Yes |
| `alert_rules.technical.manage` | Technical alert rules | Rules that raise platform alerts. | Yes | — | — | — |
| `alert_rules.business.manage` | Business alert rules | Rules that raise alerts about your teams’ work. | — | Yes | Yes | — |
| `notification_destinations.manage` | Notification destinations | Where alerts are delivered (email, chat, webhooks). | Yes | — | — | — |

### People and access

| Permission | Label | What it allows | Tech | Head | Lead | Service |
|---|---|---|:-:|:-:|:-:|:-:|
| `teams.manage` | Manage teams | Create teams and change the teams you belong to. | — | Yes | — | — |
| `users.read` | Read people | Everyone with access, their preset and teams. | Yes | Yes | Yes | — |
| `users.manage` | Manage every user | Create users of any preset and change anyone’s preset and teams (increases need approval). | Yes | — | — | — |
| `users.manage_team` | Manage team members | Create and change colleagues who share a team with you and whose rights do not exceed yours. | — | Yes | Yes | — |
| `permissions.read` | Read permissions | A colleague's effective permissions and where each came from. | Yes | Yes | Yes | — |
| `permissions.manage` | Change permissions | Grant and revoke single permissions. Grants need approval; revokes apply at once. | Yes | Yes | — | — |

### Approvals

| Permission | Label | What it allows | Tech | Head | Lead | Service |
|---|---|---|:-:|:-:|:-:|:-:|
| `approvals.read` | See approvals | Proposals you made, proposals waiting for you, and those of your teams. | Yes | Yes | Yes | Yes |
| `approvals.reassign_any` | Reassign any approval | See every open approval and name a different checker. | Yes | — | — | — |
| `approvals.check.agents` | Check agent changes | Approve agents, prompt versions, tool grants, escalation rules and business alert rules. | — | Yes | — | — |
| `approvals.check.routing` | Check routing changes | Approve routers, queues and SLA policies. | — | Yes | — | — |
| `approvals.check.channels` | Check channel changes | Approve channels and message templates. | — | Yes | — | — |
| `approvals.check.platform` | Check platform changes | Approve model providers and profiles, MCP connections, destinations, webhooks, technical alert rules and deployment settings. | Yes | Yes | — | — |
| `approvals.check.permissions` | Check access changes | Approve new users, preset upgrades, team additions and permission grants. | Yes | Yes | — | — |

### Audit and exceptions

| Permission | Label | What it allows | Tech | Head | Lead | Service |
|---|---|---|:-:|:-:|:-:|:-:|
| `audit.read` | Read the audit log | Changes made by your teams or to what your teams own. | Yes | Yes | Yes | — |
| `audit.read_all` | Read the whole audit log | Every audited change in the deployment. | Yes | — | — | — |
| `audit.verify` | Verify the audit chain | Re-check the audit store's hash chain and signed checkpoints. | Yes | — | — | — |
| `exceptions.read` | Read exceptions | What went around or wrong in the controls, live and weekly. | Yes | Yes | — | — |
| `exceptions.sign` | Sign exception reports | Sign the weekly exception report. | — | Yes | — | — |

### Ask OCSO

| Permission | Label | What it allows | Tech | Head | Lead | Service |
|---|---|---|:-:|:-:|:-:|:-:|
| `internal_agent.use` | Use Ask OCSO | Ask the internal assistant; it acts with your own permissions. | Yes | Yes | Yes | Yes |

## Permissions a preset can never hold

`NON_GRANTABLE_BY_PRESET` blocks grants that would break the separation of duties the presets encode
(PM/research/11 §3.2). It is enforced when a change is proposed and again when it applies, so neither a checker nor
bootstrap self-approval can override it.

| Preset | Never grantable |
|---|---|
| Tech | `conversations.read`, `conversations.read_team`, `conversations.claim`, `conversations.take_over`, `conversations.reply`, `conversations.note`, `conversations.return_to_ai`, `conversations.resolve`, `conversations.transfer`, `conversations.assign`, `customers.read`, `customers.manage`, `tools.execute_human`, `tools.confirm_sensitive`, `copilot.use`, `reviews.manage`, `corrections.manage`, `prompts.edit`, `analytics.business.read` |
| Head | none |
| Lead | none |
| Service | none |

In words: a Tech user never sees conversation content or customer data, never edits prompts and never reads
business analytics. Technical debugging uses traces, usage and turn metadata, which never include transcript text.

## Approval check permissions

Every approvable object kind names one permission a checker must hold (its `checkPermission`). A maker can never
check their own proposal. The kinds, from the approval descriptors in
[`packages/application/src`](../../packages/application/src):

| Permission | Object kinds it checks (approval kind: actions) | Presets |
|---|---|---|
| `approvals.check.agents` | `agent` (Virtual agent: ACTIVATE, UPDATE, DELETE); `prompt_version` (ACTIVATE); `agent_tool_grant` (UPDATE); `escalation_rule` (ACTIVATE, UPDATE, DELETE); `alert_rule` (Business alert rule: ACTIVATE, UPDATE, DELETE) | Head |
| `approvals.check.routing` | `router` (ACTIVATE, UPDATE, DELETE); `queue` (CREATE, UPDATE); `sla_policy` (CREATE, UPDATE) | Head |
| `approvals.check.channels` | `channel` (ACTIVATE, UPDATE, DELETE); `message_template` (CREATE, DELETE) | Head |
| `approvals.check.platform` | `model_provider`, `model_profile`, `model_pricing`, `mcp_connection`, `notification_destination`, `webhook_subscription`, `sso_provider`, `alert_rule_technical` (each ACTIVATE, UPDATE, DELETE); `deployment_settings` (UPDATE) | Head, Tech |
| `approvals.check.permissions` | `user` (CREATE, ACTIVATE); `permission_change` (UPDATE) | Head, Tech |

Notes:

- **Bootstrap.** When nobody else could check a proposal, a maker who holds the check permission may approve it
  themselves; this is recorded (and shows up in [exceptions](../concepts/governance.md)). For `channel` proposals a
  maker holding `approvals.check.platform` may also bootstrap (the descriptor's `bootstrapPermission`), so a Tech
  user can bring the first channel live in an empty deployment.
- `approvals.reassign_any` (Tech) lets someone see every open approval, name a different checker, and void a
  proposal nobody can decide. It does not let them approve.
- The live list of kinds and their check permissions is served by `GET /v1/approvals/kinds`.

## Related API routes

| Route | Access | What it returns or does |
|---|---|---|
| `GET /v1/permissions/catalogue` | any signed-in user | Every permission, its label, group and description, and the presets that hold it. |
| `GET /v1/users/:id/permissions` | `permissions.read` | A user's effective permissions and where each came from (preset, grant, revoke). |
| `POST /v1/users/:id/permission-changes` | `permissions.manage`, `users.manage` or `users.manage_team` | Change preset, grants and revokes. Reductions apply at once (200); widening is proposed (202) or refused with 409 `approval_required` when no checker was named. |
| `GET /v1/approvals/kinds` | `approvals.read` | The approval kinds and their check permissions. |

See the [HTTP API reference](http-api.md) for the error shape.

## Regenerating this page

The matrix was produced by a short script against `packages/auth/dist` (run `pnpm build` first):

```js
// node perm-matrix.mjs ./packages/auth/dist/index.js
const auth = await import(new URL(process.argv[2], `file://${process.cwd()}/`).href);
const { PERMISSION_GROUPS, PERMISSION_INFO, ROLE_PERMISSIONS, ROLES, ROLE_LABELS, NON_GRANTABLE_BY_PRESET, ALL_PERMISSIONS } = auth;
for (const group of PERMISSION_GROUPS) {
  console.log(`\n### ${group}\n`);
  console.log(`| Permission | Label | What it allows | ${ROLES.map((r) => ROLE_LABELS[r]).join(' | ')} |`);
  console.log(`|---|---|---|${ROLES.map(() => ':-:').join('|')}|`);
  for (const p of ALL_PERMISSIONS.filter((p) => PERMISSION_INFO[p].group === group)) {
    const cells = ROLES.map((r) => (ROLE_PERMISSIONS[r].has(p) ? 'Yes' : NON_GRANTABLE_BY_PRESET[r].has(p) ? 'Never' : '—'));
    console.log(`| \`${p}\` | ${PERMISSION_INFO[p].label} | ${PERMISSION_INFO[p].description} | ${cells.join(' | ')} |`);
  }
}
```

When you add a permission: add it to `permissions.ts`, give it a `PERMISSION_INFO` entry (a unit test fails
without one), add it to the presets that should hold it, and regenerate this table.

## Related

- [Governance: maker–checker, presets and teams](../concepts/governance.md)
- [Audit](../concepts/audit.md)
- [Sign-in and MFA per role](../guides/sign-in.md)
- [HTTP API reference](http-api.md)
- [Engineering rules](../contributing/engineering-rules.md)
