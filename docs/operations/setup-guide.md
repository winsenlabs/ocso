# Setting up OCSO

From an empty deployment ([compose.md](compose.md) or [aws.md](aws.md)) to a live virtual agent. Every
step is done in the web app by the role named; everything is audited.

**Roles.** There are four presets. **Tech** runs the platform and never reads conversations. **Head** has
full authority inside their teams and checks other people's changes. **Lead** runs their teams' agents,
queues and routers, but cannot check. **Service** handles their teams' conversations. Per-user grants
(optionally expiring) and revokes adjust a preset (ADR-029).

**Approvals (maker–checker, ADR-030).** A new object starts as an inert draft that you edit directly.
Taking it live, deleting it, and changing it once it is approved or live are all *proposals*: you name a
checker, and the change applies when they approve it on **Approvals**. Without a checker the API answers
`approval_required`. Stops apply at once and never wait for approval: pausing an agent, disabling a
channel, router or rule, removing a tool grant, revoking a permission. Who checks what:

| Change | Checked with | Held by |
|---|---|---|
| Agents, prompts, tool grants, escalation rules, business alert rules | `approvals.check.agents` | Head |
| Routers, queues, SLA policies | `approvals.check.routing` | Head |
| Channels, message templates | `approvals.check.channels` | Head |
| Providers, profiles, prices, shared MCP connections, alert destinations, webhooks, SSO, deployment settings, technical alert rules | `approvals.check.platform` | Tech, Head |
| New users, re-enabling users, permission increases | `approvals.check.permissions` | Tech, Head |

**Bootstrap.** When nobody else anywhere can check a change, a maker who holds the check permission may
approve their own change. It is recorded as a bootstrap approval and listed in the weekly exception
report. A fresh deployment with one Tech admin works this way: that admin bootstraps the platform
changes and new users. They can also bootstrap a channel while nobody holds `approvals.check.channels`.
Bootstrap stops as soon as a second eligible checker exists. Invite a Head (and a second Tech admin) early.

**Upgrading an existing deployment** changes nobody's access. Roles are mapped automatically (migration
0021): Platform Tech Admin → Tech, CS Lead → Head, CS Exec → Service. Everything already live is recorded
as approved (migration 0031), so it keeps running. Its *next* change is a proposal.

## 1. First run (Tech)

Before the first start, the operator configures **email** (invites, password resets, sign-in codes,
alert emails): `EMAIL_DRIVER=resend`, `EMAIL_FROM` on a domain verified in Resend, and the API key as a
secret file — [compose.md §9](compose.md#9-email-resend-or-smtp). It is deployment configuration, not a
UI setting; in production api and worker do not start without it.

1. Open the public URL; you are sent to `/setup`. Enter the one-time setup token (Compose:
   `docker compose logs api | grep "setup token"`; AWS: the bootstrap secret), the organization, and the
   first Tech admin's email and password. The token stops working once a user exists. Default alert
   rules and the in-app alert destination are created at the same time and recorded as approved.
2. **Settings** → deployment label, region label, timezone, data-residency zone, fallback policy
   (cross-provider / cross-region), whether Service members may view AI-active conversations, and data retention
   per class (see docs/15 notes). Settings changes are a proposal (one open at a time; a sole Tech admin
   bootstraps it). **Email** shows the configured driver and sender; use **Send test
   email** to check delivery before inviting anyone.
3. **Team & roles** → **New user** invites people: name, work email, preset, teams. A Tech admin can
   invite any preset. A Head or Lead can invite only people whose rights fit inside their own, into their
   own teams. A new user is **pending approval** and cannot sign in until a checker (Tech or Head,
   `approvals.check.permissions`, never the maker or the new user) approves them. A sole Tech admin
   bootstraps. After approval OCSO emails a single-use link (valid 72 hours) where the person
   chooses their own password; the table shows *invite pending* / *invite expired* and **Resend invite**
   (the old link stops working). **Reset link** sends an existing user a 24-hour link to choose a new
   password (their sessions end when they use it). While email is not configured (log driver), no
   email leaves OCSO: the dialog shows the link once for you to hand over privately. Heads create
   teams (they join the teams they create). Heads and Leads add people to their own teams. A user's
   **Permissions** tab adds per-user grants (with an optional expiry) and revokes. Anything that widens
   access (a grant, a stronger preset, joining a team) is a proposal. Anything that narrows it applies at once.
4. **Settings → Sign-in security** (Tech):
   - **Require MFA for roles.** Users of a checked role must use a second factor. Someone signing in
     with only a password is sent to *Set up two-factor authentication* (authenticator app: scan the QR
     code or type the key, confirm a code, save the 10 backup codes — shown once) and cannot use
     anything else until done. Passkeys and SSO count as a second factor. Recommended: Tech
     and Head.
   - **Single sign-on.** *Add SSO provider*: OpenID Connect (issuer URL, client ID, client secret —
     write-only) or SAML 2.0 (IdP single sign-on URL, IdP entity ID, signing certificate), plus the
     email domains it serves. Register the shown redirect URI (OIDC) or ACS URL + SP metadata URL
     (SAML) at the IdP. Users whose email is on a listed domain see *Continue with single sign-on* on
     the sign-in page. An existing (e.g. invited) user is linked by email; unknown users are refused
     unless you switch the provider to *Auto-provision*. They are then created as Service members,
     pending approval, and can sign in once a checker approves them. A new provider is a draft until
     its go-live is approved. An IdP on a private network must be listed in `OCSO_AUTH_TRUSTED_ORIGINS`.
5. **Your account → Account security** (everyone): change password (signs out your other sessions),
   turn on two-factor authentication, add passkeys (sign in with your device's fingerprint, face or
   PIN), see where you are signed in and sign out other sessions. The sign-in page has **Forgot
   password?** (1-hour emailed link).

**Break-glass.** Keep at least one Tech admin who signs in with a password (OCSO refuses to
disable or demote the last one) and store their backup codes safely. If every Tech admin is locked out
(lost authenticator and backup codes, IdP down, no email), the operator sets `OCSO_RECOVERY_TOKEN` to a
random value of at least 32 characters (Compose: in `.env` or as `OCSO_RECOVERY_TOKEN_FILE` on the
secrets volume), restarts the api and opens `/recover`: token, the Tech admin's email and a new
password. It resets that admin's password, removes their authenticator app (they enrol again) and ends
their sessions; each token value works once and the use is audited. Remove the variable afterwards.

## 2. Model providers and profiles (Tech)

**Connections & models → Model providers.** Add one or more providers. Credentials are write-only and
stored in the secret store; the model never sees them. **Test** makes a real call. A provider is created
disabled; enabling it is a proposal. A replacement credential is staged, and the checker sees only "new
value (proposed)".

| Provider | Settings | Credentials | Prompt caching |
|---|---|---|---|
| AWS Bedrock | region, auth mode (`ACCESS_KEYS` / `IAM_ROLE` / `API_KEY`), optional base URL | access key id + secret (+ session token) or API key; none for `IAM_ROLE` (grant `bedrock_model_arns` in Terraform) | explicit cache points after the stable prefix |
| Google Vertex AI | project, location, auth mode (`SERVICE_ACCOUNT_KEY` / `APPLICATION_DEFAULT`) | service-account JSON | implicit for Gemini; cache control for Claude on Vertex |
| Microsoft Foundry | resource name or endpoint, auth (`API_KEY` / `ENTRA_ID`), deployments (model family, API) | API key, or tenant id + client id + secret | prompt cache key (OpenAI models); cache control (Claude models) |
| OpenAI | optional base URL, organization, project | API key | prompt cache key + retention |
| Anthropic | optional base URL | API key | cache control breakpoints (≤ 4) |
| Sarvam AI | base URL | API subscription key | reported as unverified until observed |

**Model profiles** are the logical names agents use (`support-primary`, `summarizer`, …): primary provider
and model, ordered fallbacks, retries, timeout, cache policy/TTL and required capabilities (image, file,
audio input, tool calling). The dialog validates every target against the deployment policy (allowlist,
residency, cross-provider/region fallback) before it can be saved. A profile must be approved (**Approve
for use**) before a live agent, the internal agent or a router's classifier can use it.

**Choosing a model.** The Model field, and each fallback's model field, is a searchable list of what
the chosen provider actually offers with the configured credentials:

| Provider | Where the list comes from |
|---|---|
| OpenAI, Anthropic | `GET /v1/models` (chat models only for OpenAI) |
| Bedrock | Foundation models, plus cross-region and application inference profiles, in the provider's region |
| Vertex | Gemini and Claude models from Model Garden |
| Foundry | The deployments you listed in the provider settings |
| Sarvam | Its `/models` endpoint |

- **What each entry shows.** Context window, input kinds and tool calling when known, and the price:
  the configured price, or the catalog's offer.
- **Free text still works.** You can type any id the list does not return, such as a fine-tune or a
  brand-new model.
- **Refresh.** Lists are cached for 10 minutes. Tech admins get a **Refresh** button.
- **Errors.** If the key is wrong or the provider is down, the field says so, and you can still type
  the id.

**Prices.** OCSO costs every model call from **Model pricing** (per 1M tokens: input, output, cache
read, cache write, plus long-context tiers).

- **Catalog prices on save.** When you save a profile, any model without a price gets one from the
  open-source model catalog, if the catalog knows it. These rows are marked **catalog**, with their
  source (models.dev or LiteLLM) and the date checked.
  - Catalog rows follow the catalog. The worker refreshes it daily, and **Refresh catalog** refreshes
    it on demand. Every change is audited.
  - **Edit a price to override it.** The edit is a proposal; once approved the row becomes **manual**,
    and refreshes never change manual rows again. Use this for negotiated rates, batch or regional pricing, and 1-hour cache-write rates.
- **Missing prices.** After a save, the dialog lists any model with **no price**. Add one there, or
  later from **Models in use without a price** under Model pricing, which also offers **Use catalog
  price** when the catalog has one.
- **Usage without a price is shown as "no price"** in telemetry, never as a zero cost.
- **Offline deployments** use the catalog copy bundled with OCSO. Outbound https to `models.dev` and
  `raw.githubusercontent.com` is needed only for refreshes. Set `OCSO_MODEL_CATALOG_REFRESH=false` on
  the API and worker to turn refreshes off.

## 3. Channels (Tech; a Head approves)

**Connections & models → Channels → Add channel.**

WhatsApp comes in two flavours; pick the one your number is registered with. **WhatsApp — Twilio** is the
usual path; **WhatsApp — Meta Cloud API** is for numbers registered directly with Meta. Both store the customer
under the same phone identity, so a person is one customer whichever integration they reach.

- **WhatsApp — Twilio.** In the Twilio Console you need a WhatsApp sender (Messaging → Senders → WhatsApp
  senders; for testing, the Sandbox `whatsapp:+14155238886`, which recipients join with `join <code>`).
  In OCSO enter:
  - **Account SID** (`AC…`, Console → Account info) and the **auth token** (secret). Twilio signs every webhook
    with the auth token, so it is required even if you send with an API key.
  - Optionally an **API key SID** (`SK…`) and its **API key secret**: sending and media downloads then use
    the key instead of the auth token.
  - The **WhatsApp sender** `whatsapp:+<E.164>` **or** a **Messaging Service SID** (`MG…`) whose sender pool
    holds the WhatsApp sender (exactly one of the two).
  - **Request delivery statuses** (on by default): OCSO asks Twilio to post each message's status to the
    channel's webhook URL. This needs an `https` `OCSO_PUBLIC_URL`; otherwise set the status callback in Twilio.

  After saving, copy the webhook URL shown (`<public URL>/channels/twilio-whatsapp/<key>/webhook`) into the
  sender's (or Messaging Service's Integration / Sandbox) settings as the **incoming-message webhook, HTTP
  POST**, and as the **status callback URL**. Paste it exactly — no trailing slash: Twilio signs the exact URL
  and OCSO rejects any request whose `X-Twilio-Signature` does not match `OCSO_PUBLIC_URL` + that path. Press
  **Test connection** to check the credentials read-only (Twilio's account is fetched; no message is sent).
  Outside WhatsApp's 24-hour customer window only approved templates reach the customer (see **WhatsApp
  templates** below); OCSO lists and sends them with these same credentials through Twilio's Content API
  (`content.twilio.com`). Twilio caps a message body at 1,600 characters (OCSO splits longer replies) and
  sends one media item per message.
- **WhatsApp — Meta Cloud API.** In Meta: a WhatsApp Business account, a phone number, a system-user
  access token with `whatsapp_business_messaging` (sending) and `whatsapp_business_management`
  (templates), and the app secret. In OCSO: the phone number id, the **WhatsApp Business Account id**
  (WABA id — required for templates; without it the template list says so), the access token, the app
  secret and a verify token (**Generate** makes one — copy it). After saving, copy the webhook URL shown
  (`<public URL>/channels/whatsapp/<key>/webhook`) into Meta's webhook settings with the same verify token
  and subscribe to `messages` and `message_template_status_update` (template review results arrive
  immediately; otherwise OCSO polls every 3 minutes). OCSO verifies every webhook signature with the app
  secret and ignores duplicates.
- **Web chat.** Set the allowed origins (sites that may embed the widget; empty = any), branding (title,
  greeting, accent colour, theme, position) and, for signed-in customers, a host identity secret your site
  uses to sign `identify()` tokens (HS256). Paste the snippet shown after saving into your site:
  `<script src="<public URL>/ocso-webchat.js" data-key="<key>" async></script>`. See
  `examples/webchat-host/` for identify().

A new channel is a draft. Taking it **Active** is a proposal checked by a Head (`approvals.check.channels`).
While nobody holds that permission, a sole Tech admin may bootstrap it. Disabling is immediate, and
resuming is a proposal. A channel no longer names an agent: it is attached to a **router**, which picks
the queue and so the agent (§5a).

### WhatsApp templates (Lead, Head or Tech; a Head approves)

WhatsApp allows free-form replies only for 24 hours after the customer's last message. After that the
business may only send a **template** WhatsApp approved in advance. Templates are business content, so
Leads and Heads (for channels their teams' agents use) and Tech admins draft them (`message_templates.manage`).
Submitting a draft to WhatsApp and deleting a template are proposals checked by a Head
(`approvals.check.channels`).

- **Create in OCSO.** **Message templates** in the sidebar (Tech: also **Templates** on a WhatsApp
  channel card) → **New template**. Give a name (`payment_reminder`: lower-case, digits, underscores), a
  language code (`en`, `en_US`, `hi`…) and a category:
  - **Utility** — about something the customer already asked for or bought (payment due, case update).
  - **Marketing** — anything promotional; customers can opt out and it is billed as marketing.
  - **Authentication** — one-time codes only; WhatsApp fixes the text and adds a copy-code button.

  Write the message with numbered variables `{{1}}`, `{{2}}` and an example value for each (reviewers see
  the examples), optionally a text or media header (media: a public `https` sample link — Twilio only; for
  Meta create media templates in WhatsApp Manager), a footer and either quick replies or call-to-action
  buttons. The builder applies WhatsApp's review rules as you type (no variable at the start or end, none
  side by side, enough words per variable, limits) and warns when a utility template reads as promotional.
  **Submit for WhatsApp approval** opens the OCSO approval; once a Head approves, the worker creates the template at the provider (Twilio: a Content resource, then an
  approval request; Meta: `message_templates`) and records who submitted it. Review usually takes minutes
  and up to 24 hours: the worker checks templates in review every 3 minutes (Meta also pushes the result),
  the templates page updates live, and the submitter gets an in-app notice with the result and, for a
  rejection, the reason.
- **Create at the provider.** Templates made in Twilio's Content Template Builder (submitted for WhatsApp
  approval) or in WhatsApp Manager appear in OCSO too — the list is read from the provider (cached 5
  minutes; **Refresh** re-reads it).
- **Send.** Service members pick an approved template in the conversation composer (**Template**), fill every
  variable and check the preview; see docs/09 §4. Only `APPROVED` templates can be sent; pending, rejected,
  paused and disabled ones are listed with their status. Templates using components OCSO cannot send yet
  (location headers, catalog/flow buttons, carousels) are shown but disabled.
- **Delete** (a proposal; Heads hold `message_templates.delete`) removes the template at the provider (Meta blocks an approved name for 30 days; Twilio
  removes its Content resource).

## 4. MCP tool servers (Tech)

**Connections & models → MCP connections → Add MCP server** walks through: URL → discover → authenticate
(static header or OAuth 2.1; OAuth opens the provider's consent page and returns to OCSO) → classify each
tool's risk (`READ` / `WRITE` / `SENSITIVE`) and which human roles may run it → approve (which agents may
use it, confirmation policy, trusted) → active. Going live is a proposal: after approval the worker
probes the server and blocks the approval if its tool set changed since the checker saw it. Health is
checked on the configured interval.

- **Sensitive** tools always wait for a human's "Confirm and run" in the workspace; the exact arguments
  shown are the ones executed.
- **Trusted** connections receive a short-lived signed customer-identity token in
  `X-OCSO-Customer-Claims` (ES256, 120 s). Verify it against `<public URL>/.well-known/jwks.json`, check
  `iss` and `aud` (`ocso-mcp:<connection id>`), and use `sub` (your customer reference) to scope data.
  `examples/mcp-bank-demo/src/claims-jwks.ts` is a complete verifier.
- Internal hosts (private IPs, `http://`) are blocked unless listed in the egress allowlist (Settings API).
- If a server changes a tool's schema or description, the tool is un-approved until re-reviewed.
- Users can connect personal accounts from templates an admin publishes (**My connections**); agents
  never use personal connections.

## 5. Virtual agents (Lead; a Head approves)

**Teams come first.** Every virtual agent is owned by one or more teams, and a Head or Lead sees and
manages only the agents their teams own (ADR-026). Before creating agents:

- a Head creates the team on **Team** (`teams.manage`) and joins it;
- a Tech admin or a Head of the team adds the Lead to it (**Team → user → teams**; nobody changes their
  own memberships). Adding someone to a team is a proposal. A Lead in no team sees "Join or create a team
  to create agents" instead of **New agent**.

**Virtual agents → New agent**: name, **owning team** (one or more of your teams), purpose, conversation
type, model profile (plus optional summarizer and copilot profiles), default queue. Channels reach agents
through routers and queues (§5a); the agent's Channels tab lists them as "Reached through". Other teams'
Heads and Leads cannot see the agent, its conversations (unless routed to their queues), analytics, reviews or alerts.
The agent's **Settings → Owning teams** card adds or removes your own teams as owners; a Tech admin can
reassign any agent there (e.g. when a Lead leaves), and every change is audited. Then:

1. **Prompt** — edit the business components (identity, objective, behavior, policies, escalation, …).
   The preview shows the compiled prompt, token estimate and the cache-prefix hash. **Create version** with
   a reason; **Activate** when ready (rollback = activate an older version). Replay a draft against past
   conversations before activating.
2. **Tools** — grant approved tools; optionally always-confirm and argument rules (e.g. amount above a
   limit requires confirmation). On a live agent, a grant that widens access is a proposal, while removing
   or narrowing one applies at once.
3. **Escalation** — deterministic rules that hand the conversation to humans (keywords, the customer
   asking for a person, consecutive tool failures, amounts above a threshold) with mode, target queue and
   priority; judgement calls stay in the prompt's escalation component. Rules are created off. Turning
   one on is a proposal, and turning it off is immediate.
4. **Routing** — the agent answers through a queue (§5a); auto-assign vs open pickup and the SLA policy
   are set on the queue.
5. **Go live** — a proposal a Head approves. The checker sees the active prompt, the tool grants and the
   escalation rules going live. Pausing is immediate, and resuming is a proposal.

## 5a. Queues and routers (Lead; a Head approves)

Customers reach an agent as **channel → router → queue → agent**. Every step below that makes something
live is a maker–checker proposal: name a Head of the team as checker (Heads hold `approvals.check.routing`).

1. **SLA policies → New SLA policy**, then **Submit** it for approval (a queue can be approved only with an
   approved policy).
2. **Queues → New queue**: name, the **AI agent** (exactly one per queue; one agent may serve many queues),
   **attributes** such as `language = ta` (unique across queues; routers' rules send customers here by
   them), teams, human hours (or the agent's), transfer targets, pickup mode and SLA policy. The queue is a
   draft: **Submit** it for approval. After approval, edits open the submit dialog; removing a transfer
   target or unlinking your team applies at once.
3. **Routers → New router**: a name and the fallback queue. In the builder add steps — a **menu question**
   (ASK: the question, options with values and synonyms), a **model classifier** (CLASSIFY: an approved
   model profile, labels, minimum confidence, follow-ups) or a **known fact** (the customer's language or a
   customer attribute) — then rules (**Rules from queue attributes** writes one rule per attribute queue),
   returning customers (ask continue-or-new after N hours/days/months) and the timeout. **Simulate** to see
   the decision trace. Tick the router's **channels** (direct while it is a draft), **Save as new version**,
   then **Activate v1**: a Head approves it (Approvals). A queue or agent still waiting for its own approval
   shows as a warning; approve those first.
4. For WhatsApp, a router question outside the 24-hour window needs an approved template: **Create template
   for <channel>** on the message drafts one from its text and opens its approval.
5. **Disable** a router to stop new conversations at once (customers mid-conversation are unaffected);
   resuming is an approval. Existing channels were given a pass-through router by the upgrade (0025).
   A proposal to activate a new version that was waiting when the router was disabled is blocked on
   approval (it would undo the stop): propose **Resume with vN** instead.

Who may change what:

- A router that has gone live belongs to the teams its live version serves (the teams of its queues and of
  their agents). Only their Leads and Heads edit, disable, detach or propose changes to it, and only their
  Heads check those proposals; the approval shows the **served teams** before and after. A router that never
  went live is open to any routers.manage holder.
- A channel another router routes cannot be attached elsewhere: detach it on that router first (its teams
  do that). Detaching is a stop, applied at once.
- Only approved queues take customers: the AI's transfer tool offers only approved transfer targets, and a
  human transfer into a queue nobody approved is refused. A queue with any live reach (routed to, a live
  agent's default queue, an escalation target, or a transfer target of one of those) changes only through
  approval, and its last team cannot be unlinked.
- A router that has routed customers is never deleted — its versions are their routing record. Disable it.
- **Two checkers.** Give routing at least two Heads (in the teams concerned, or anywhere as the
  platform-wide fallback). With one, every routing change is that Head's bootstrap self-approval (listed
  in the exception report), and a router a Lead disabled stays off until that Head resumes it — Tech does
  not hold approvals.check.routing.

## 6. People and operations (Head and Lead)

Teams (Heads create them before agents, §5), Service members (languages, skills, maximum concurrent conversations), queues (pickup mode, teams, SLA policy; §5a). Service members set
their availability on Home. A Head's or Lead's inbox, customers, analytics, reviews and alerts cover their teams'
agents plus conversations routed to queues their teams serve; Service members keep their queue-based view. Reviews, prompt corrections, analytics and escalation reasons are under
Quality.

## 7. Alerts and webhooks

- **Alerts** — default rules exist from setup. Tech admins manage technical rules (workers, queue age,
  provider errors, latency, MCP health, token/cost spikes, …); Heads and Leads manage business rules (escalation
  rate, SLA breaches, CSAT, tool failures, …). New rules are created off. Turning one on, changing an
  approved one and deleting are proposals (technical rules: `approvals.check.platform`; business rules:
  `approvals.check.agents`). Turning a rule off is immediate.
- **Monthly model budget** (Tech, not created by default). Add a technical rule with the
  condition **Monthly model spend above budget** (`spend_budget_above`).
  - **Params:** `monthlyBudgetUsd` (e.g. `2000`) and `thresholdsPercent` (default `[80, 100]`).
    Optionally bind the rule to one virtual agent.
  - **What it counts:** model spend so far this calendar month in the deployment timezone.
  - **When it fires:** once per threshold per month. The alert shows spend, budget and the projected
    month-end spend at the current rate, and names any models that ran without a price. Those are not
    counted, so add their prices.
  - **When it resolves:** when the month rolls over. Destinations: in-app, email (the deployment sender by default,
  or its own SMTP relay), Slack, Teams, signed webhook, PagerDuty — each with a **Test** button.
- **Webhooks** (Tech) — enabling a subscription is a proposal. Subscribe external systems to events such as `conversation.resolved` or
  `alert.opened`. The signing secret is shown once; verify `X-OCSO-Signature: t=<unix>,v1=<hex
  HMAC-SHA256(secret, "<t>.<body>")>` and dedupe on the envelope `id`.

## 8. Ask OCSO (internal agent)

Settings → Ask OCSO → choose an approved model profile (a settings proposal). Every user can then press ⌘J / Ctrl+J. It answers with the
user's own permissions; any change it proposes needs the user's explicit confirmation and is audited as
done by that user through the internal agent. Pausing an agent works from Ask OCSO, but putting one live
(`set_agent_status`) and changing worker settings (`update_worker_settings`) answer `approval_required`:
make those changes in the app, where they become proposals.

## 9. Workers and scaling (Tech)

System → Workers (a settings proposal; the maker also needs `system.configure`): conversations per worker, warm floor and maximum, target utilization, scale-out
thresholds, cooldown, turn timeout, lease and heartbeat. On ECS the deployment adapter applies them to
the service's autoscaling; on Compose they are advisory and the page shows the `--scale worker=N` command
([worker-scaling.md](worker-scaling.md)).

## 10. Audit, approvals and the exception report

- **Approvals** lists what awaits you, what you sent, and every open and decided proposal in your scope.
  A proposal whose object changed since submission cannot be approved (`content_changed`): the maker
  edits it and it comes back to you.
- **Audit** reads the separate audit store (ADR-032). **System → Audit store** shows shipping lag, the
  sealed position, the last signed checkpoint, exports and incidents. **Verify recent entries** needs
  `audit.verify` (Tech). For an offline check, see [compose.md §10](compose.md#10-the-audit-store-adr-032).
- **Exceptions** (Heads and Tech read it; Heads sign it) is the live view of where controls were
  bypassed or failed: configuration live without an approval, bootstrap self-approvals, access granted
  around approval, changes made outside an approval, routing fallbacks, failed deliveries and audit-chain
  problems. Right after an upgrade it lists everything grandfathered by migration 0031 once, as
  low-severity *installed only* items. Every Monday the worker freezes the previous week as a report. A
  Head signs it with the audit signing key and exports a ZIP that an auditor verifies offline with
  `openssl` (steps in its `VERIFY.txt`). **System → Storage** shows table growth and when to consider
  moving the audit store to a columnar driver.
