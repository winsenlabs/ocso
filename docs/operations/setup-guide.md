# Setting up OCSO

From an empty deployment ([compose.md](compose.md) or [aws.md](aws.md)) to a live virtual agent. Every
step is done in the web app by the role named; everything is audited.

## 1. First run (Platform Tech Admin)

1. Open the public URL; you are sent to `/setup`. Enter the one-time setup token (Compose:
   `docker compose logs api | grep "setup token"`; AWS: the bootstrap secret), the organization, and the
   first Tech Admin's email and password. The token stops working once a user exists. Default alert
   rules are created at the same time.
2. **Settings** → deployment label, region label, timezone, data-residency zone, fallback policy
   (cross-provider / cross-region), whether CS Execs may view AI-active conversations, and data retention
   per class (see docs/15 notes).
3. **Team & roles** → invite the CS Leads. CS Leads create teams and CS Execs.

## 2. Model providers and profiles (Tech Admin)

**Connections & models → Model providers.** Add one or more providers. Credentials are write-only and
stored in the secret store; the model never sees them. **Test** makes a real call.

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
residency, cross-provider/region fallback) before it can be saved. **Pricing** (per 1M tokens: input,
output, cache read, cache write) drives the cost figures in telemetry.

## 3. Channels (Tech Admin)

**Connections & models → Channels → Add channel.**

- **WhatsApp Business (Cloud API).** In Meta: a WhatsApp Business account, a phone number, a system-user
  access token with `whatsapp_business_messaging`, and the app secret. In OCSO: the phone number id
  (and optionally the WABA id), the access token, the app secret and a verify token (**Generate** makes
  one — copy it). After saving, copy the webhook URL shown (`<public URL>/channels/whatsapp/<key>/webhook`)
  into Meta's webhook settings with the same verify token and subscribe to `messages`. OCSO verifies every
  webhook signature with the app secret and ignores duplicates.
- **Web chat.** Set the allowed origins (sites that may embed the widget; empty = any), branding (title,
  greeting, accent colour, theme, position) and, for signed-in customers, a host identity secret your site
  uses to sign `identify()` tokens (HS256). Paste the snippet shown after saving into your site:
  `<script src="<public URL>/ocso-webchat.js" data-key="<key>" async></script>`. See
  `examples/webchat-host/` for identify().

Choose the channel's default virtual agent (created in §5) and set it **Active**.

## 4. MCP tool servers (Tech Admin)

**Connections & models → MCP connections → Add MCP server** walks through: URL → discover → authenticate
(static header or OAuth 2.1; OAuth opens the provider's consent page and returns to OCSO) → classify each
tool's risk (`READ` / `WRITE` / `SENSITIVE`) and which human roles may run it → approve (which agents may
use it, confirmation policy, trusted) → active. Health is checked on the configured interval.

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

## 5. Virtual agents (CS Lead)

**Virtual agents → New agent**: name, purpose, conversation type, model profile (plus optional summarizer
and copilot profiles), default queue, channels. Then:

1. **Prompt** — edit the business components (identity, objective, behavior, policies, escalation, …).
   The preview shows the compiled prompt, token estimate and the cache-prefix hash. **Create version** with
   a reason; **Activate** when ready (rollback = activate an older version). Replay a draft against past
   conversations before activating.
2. **Tools** — grant approved tools; optionally always-confirm and argument rules (e.g. amount above a
   limit requires confirmation).
3. **Escalation** — deterministic rules that hand the conversation to humans (keywords, the customer
   asking for a person, consecutive tool failures, amounts above a threshold) with mode, target queue and
   priority; judgement calls stay in the prompt's escalation component.
4. **Routing** — queue, auto-assign vs open pickup, SLA policy (Queues and SLA policies pages).
5. **Go live**.

## 6. People and operations (CS Lead)

Teams, CS Execs (languages, skills, maximum concurrent conversations), queues (routing mode, teams, SLA policy). CS Execs set
their availability on Home. Reviews, prompt corrections, analytics and escalation reasons are under
Quality.

## 7. Alerts and webhooks

- **Alerts** — default rules exist from setup. Tech Admins manage technical rules (workers, queue age,
  provider errors, latency, MCP health, token/cost spikes, …); CS Leads manage business rules (escalation
  rate, SLA breaches, CSAT, tool failures, …). Destinations: in-app, email (SMTP), Slack, Teams, signed
  webhook, PagerDuty — each with a **Test** button.
- **Webhooks** (Tech Admin) — subscribe external systems to events such as `conversation.resolved` or
  `alert.opened`. The signing secret is shown once; verify `X-OCSO-Signature: t=<unix>,v1=<hex
  HMAC-SHA256(secret, "<t>.<body>")>` and dedupe on the envelope `id`.

## 8. Ask OCSO (internal agent)

Settings → Ask OCSO → choose a model profile. Every user can then press ⌘J / Ctrl+J. It answers with the
user's own permissions; any change it proposes needs the user's explicit confirmation and is audited as
done by that user through the internal agent.

## 9. Workers and scaling (Tech Admin)

System → Workers: conversations per worker, warm floor and maximum, target utilization, scale-out
thresholds, cooldown, turn timeout, lease and heartbeat. On ECS the deployment adapter applies them to
the service's autoscaling; on Compose they are advisory and the page shows the `--scale worker=N` command
([worker-scaling.md](worker-scaling.md)).
