# Alerts and webhooks

This guide covers the two ways OCSO tells people and systems that something happened: **alerts** (rules that watch
platform health and agent outcomes, and notify people through destinations such as Slack or PagerDuty) and
**event webhooks** (signed HTTP posts of OCSO events to your systems). It is for the Tech admin who sets up
destinations and technical rules, the Head or Lead who owns business rules, and the developer who receives webhooks.

Destinations and rule conditions are both plugin registries: a destination kind exists when its adapter is
registered ([packages/alerts/src/adapters/](../../packages/alerts/src/adapters/)), and a condition exists when its
evaluator is registered
([packages/application/src/alerts/evaluators/](../../packages/application/src/alerts/evaluators/)). The web forms are
rendered from their schemas.

## Alerts

### Business and technical

Every rule has a kind, and each kind has its own permissions and checker:

| Kind | Watches | Made by | Checked by | Audience roles |
|---|---|---|---|---|
| Technical | Platform health: workers, queues, providers, latency, MCP, spend, sign-ins, database | `alert_rules.technical.manage` (Tech) | `approvals.check.platform` | Tech |
| Business | Agent outcomes: escalation, SLAs, CSAT, conversion, tool failures | `alert_rules.business.manage` (Lead, Head) | `approvals.check.agents` (Head) | Head, Lead, Service |

People see alerts in **Alerts → Inbox** if their role is in the rule's audience and they can read that kind
(`alerts.technical.read` or `alerts.business.read`). An alert about one agent is shown only to people who can read
that agent.

### Conditions

The worker's scheduler leader evaluates every enabled rule every 30 seconds over the rule's window.

| Condition | Label | Kind | Parameters (defaults) |
|---|---|---|---|
| `workers_below_min` | Healthy workers below minimum | technical | `heartbeatSeconds` 30, `minimum` (default: the worker settings' minimum warm workers) |
| `queue_age_above` | Queue age above threshold | technical | `topic` `conversation.turn`, `thresholdSeconds` 30 |
| `provider_error_rate_above` | Provider error rate above threshold | technical | `thresholdPercent` 5, `minRequests` 20 |
| `latency_p95_above` | Turn latency p95 above threshold | technical | `thresholdMs` 8000, `minTurns` 10 |
| `ttft_p95_above` | Time to first token p95 above threshold | technical | `thresholdMs` 3000, `minRequests` 10 |
| `mcp_unhealthy` | MCP connection unhealthy | technical | `statuses` (all unhealthy states), `includePersonal` false |
| `token_spike` | Token usage spike | technical | `ratio` 3, `baselineWindows` 12, `minValue` |
| `cost_spike` | Model cost spike | technical | `ratio` 3, `baselineWindows` 12, `minValue` |
| `spend_budget_above` | Monthly model spend above budget | technical | `monthlyBudgetUsd` (required), `thresholdsPercent` [80, 100] |
| `auth_failures_above` | Sign-in failures above threshold | technical | `threshold` 20 |
| `database_degraded` | Database degraded | technical | `component` `database`, `latencyThresholdMs` 250, `minSamples` 1 |
| `escalation_rate_above` | Escalation rate above threshold | business | `thresholdPercent` 25, `minConversations` 20 |
| `sla_breaches_above` | SLA breaches | business | `threshold` 0 |
| `resolution_sla_breaches_above` | Resolution SLA breaches | business | `threshold` 0 |
| `repeated_failure_topic` | Repeated failure topic | business | `minOccurrences` 5 |
| `csat_below` | CSAT below floor | business | `threshold` 4, `minResponses` 20 |
| `conversion_drop` | Conversion drop vs baseline | business | `dropPercent` 30, `minOutcomes` 20, `baselineWindows` 7, `convertedOutcomes` [`CONVERTED`, `WON`] |
| `tool_failure_rate_above` | Tool failure rate above threshold | both | `thresholdPercent` 5, `minCalls` 10 |

Each condition publishes its method in plain language (`GET /v1/alert-rules/conditions`); the rule dialog shows it.
`spend_budget_above` measures month-to-date spend in the deployment timezone, fires each threshold once per month,
projects month-end spend in the alert body, and resolves at month rollover.

A fresh deployment seeds these rules: **Healthy workers below minimum**, **Conversation queue age above 30s**,
**Provider error rate above 5%**, **MCP connection unhealthy**, **Time to first token p95 above 3s**, **Database
degraded** (technical), and **Escalation rate above 25%** and **SLA breaches** (business), plus an **In-app**
destination.

### Lifecycle

Each observation is fingerprinted by rule and scope (a provider, an agent, a queue). A firing observation opens an
alert, or updates the open one. People **acknowledge** and **resolve** alerts from the inbox. With **Resolve
automatically when the condition clears** on, an open alert whose scope stops firing is resolved. A resolved alert
is not reopened within the rule's **Re-open after (seconds)** window.

### Create a rule

1. Go to **Alerts → Rules** and click **New technical rule** or **New business rule**.
2. Fill in **Rule name**, **Kind**, **Condition** (its parameters appear below it), **Severity** (`CRITICAL`,
   `WARNING`, `INFO`), **Window (seconds)** (60 to 30 days, default 300), **Re-open after (seconds)** (default 3600),
   **Audience** and **Deliver to** (destinations; alerts always appear in the inbox).
3. Save. The rule is created **off**.
4. Turn it on from the list; a checker approves the activation. Once approved, every edit is a proposal; turning a
   rule off is immediate. Deleting is always a proposal.

A rule can be scoped to one virtual agent (`agentId`) for conditions that support it, through the API
(`POST /v1/alert-rules`); the web dialog creates platform-wide rules only.

### Destinations

**Alerts → Destinations** (`notification_destinations.manage`, Tech) → **Add destination**. Pick a **Type**; the
form is rendered from the adapter's schema. Secrets (webhook URLs, routing keys, SMTP passwords) go to the secret
store and are never shown again. Each destination has a **Test** button.

| Type | Kind | Receives | Configuration | Secret |
|---|---|---|---|---|
| In-app | `IN_APP` | opened | none | none |
| Email | `EMAIL` | opened, resolved | **Send with**: **This server's email (EMAIL_DRIVER)** with **Recipients**; or **Your own SMTP relay** with **Recipients**, **SMTP host**, **Port** (587), **From address**, **SMTP user**, **Require TLS** | **SMTP password** (relay only, optional) |
| Slack | `SLACK` | opened, resolved | **Channel label** (display only) | **Incoming webhook URL** |
| Microsoft Teams | `TEAMS` | opened, resolved | **Channel label** (display only) | **Workflows or incoming webhook URL** |
| Webhook (HMAC-signed) | `WEBHOOK` | opened, acknowledged, resolved | **Endpoint URL** (https) | **Signing secret** (16+ characters) |
| PagerDuty | `PAGERDUTY` | opened, acknowledged, resolved | **Region** (`US` or `EU`) | **Events API v2 routing key** |

PagerDuty opens, acknowledges and resolves incidents with the alert fingerprint as the dedup key. The Email
destination's deployment option uses the sender described in [Email](email.md).

Deliveries run on a queue with backoff: up to 6 attempts for a transient failure. Destinations go through the SSRF
guard (public https only). A destination is created disabled; enabling it is an approval
(`approvals.check.platform`), editing an enabled one is a proposal (a new secret is staged and applied on approval),
disabling is immediate, and deleting is a proposal that also detaches it from every rule.

### Alert webhook payload

The `WEBHOOK` destination POSTs this JSON with headers `X-OCSO-Signature`, `X-OCSO-Event` (`alert.opened`,
`alert.acknowledged`, `alert.resolved`) and `X-OCSO-Delivery`:

```json
{
  "type": "alert.opened",
  "version": 1,
  "deliveryId": "…",
  "occurredAt": "2026-09-25T10:15:00.000Z",
  "deployment": "PROD",
  "alert": {
    "alertId": "…", "fingerprint": "…", "ruleId": "…", "ruleName": "…", "condition": "provider_error_rate_above",
    "kind": "TECHNICAL", "severity": "CRITICAL", "status": "OPEN", "title": "…", "body": "…", "value": "…",
    "source": "…", "context": {}, "occurrences": 1, "openedAt": "…", "lastSeenAt": "…",
    "acknowledgedAt": null, "resolvedAt": null, "resolution": null, "link": "…"
  }
}
```

The `alert` object is channel-neutral and holds no secrets. De-duplicate on `X-OCSO-Delivery`. The signature scheme
is the same as event webhooks, below.

## Event webhooks

Event webhooks push OCSO events to your systems. They live in **Integrations → Webhooks** (`webhooks.manage`, Tech).

### Events

Payloads carry identifiers and metadata only, never message text, notes, tool arguments or credentials.

| Area | Events |
|---|---|
| Conversations | `conversation.created`, `conversation.control_changed`, `conversation.resolved` |
| Messages | `interaction.received`, `interaction.sent`, `interaction.delivery_updated` |
| Handoff | `handoff.requested`, `handoff.assigned`, `assignment.changed`, `ai.resumed` |
| Agents and models | `agent.turn_completed`, `model.request_completed`, `model.fallback` |
| Tools | `tool.completed`, `tool.failed`, `tool.confirmation_requested`, `tool.confirmation_decided` |
| Alerts | `alert.opened`, `alert.updated`, `alert.resolved` |

A subscription takes up to 40 patterns: an exact type, `<area>.*` (e.g. `tool.*`), or `*`.

### Add an endpoint

1. **Integrations → Webhooks → Add endpoint**. Enter **Name** and **Endpoint URL** (https only), pick events, and click
   **Create endpoint**.
2. OCSO generates a signing secret (`whsec_…`) and shows it **once**. Store it in the receiver's secret manager.
3. The endpoint is a disabled draft. Click **Enable**; a second person with `approvals.check.platform` approves.
4. Use **Send test** to post a `webhook.test` event (not recorded as a delivery).

Once approved, changing name, URL or events is a proposal. Disabling and **Rotate secret** are immediate (rotation is
a revocation, so it is never gated). Deleting is a proposal.

### Payload

```json
{
  "id": "0199…",
  "type": "handoff.requested",
  "version": 1,
  "occurredAt": "2026-09-25T10:15:00.000Z",
  "correlationId": "…",
  "agentId": "…",
  "conversation": { "id": "…", "displayId": "conv_…", "controlState": "…", "channelKind": "WEBCHAT", "customerRef": "CIF-88214" },
  "data": { }
}
```

Headers: `x-ocso-signature`, `x-ocso-event` (the type), `x-ocso-delivery` (the delivery id), `user-agent:
OCSO-Webhooks/1`. De-duplicate on the envelope `id` (the event id): a retried delivery carries the same `id`.

Deliveries are retried with backoff on network errors and retriable statuses, up to 8 attempts. The endpoint row
shows failures in the last 24 hours; a failed delivery has a **Retry** button.

### Verify the signature

`X-OCSO-Signature` is `t=<unix seconds>,v1=<hex>`, where `v1` is HMAC-SHA256 with your signing secret over the
string `<t>.<raw request body>`. Verify it on the raw bytes before parsing JSON, compare in constant time, and reject
timestamps more than 300 seconds from your clock. The reference implementation is `verifySignature` in
[packages/alerts/src/signing.ts](../../packages/alerts/src/signing.ts).

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyOcsoSignature(header: string | undefined, rawBody: string, secret: string, toleranceSeconds = 300): boolean {
  if (!header) return false;
  const parts = new Map(header.split(',').map((p) => {
    const i = p.indexOf('=');
    return [p.slice(0, i).trim(), p.slice(i + 1).trim()] as const;
  }));
  const t = Number(parts.get('t'));
  const v1 = parts.get('v1');
  if (!Number.isInteger(t) || !v1 || !/^[0-9a-f]{64}$/.test(v1)) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - t) > toleranceSeconds) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest();
  return timingSafeEqual(expected, Buffer.from(v1, 'hex'));
}
```

## Verify it works

- **Test** on a destination delivers a test message.
- **Send test** on a webhook endpoint returns the receiver's status.
- Create a technical rule with a threshold your system already exceeds (for example `queue_age_above` with a tiny
  `thresholdSeconds`), approve it, and check the alert appears in the inbox and at its destinations within a minute.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| A rule never fires | It is off or its activation is waiting for approval; or the minimum-sample parameter (`minRequests`, `minConversations`…) is not met in the window. |
| Alert in the inbox but not in Slack | The destination is disabled, not attached to the rule, or the delivery failed (check the alert's deliveries). |
| Webhook signature mismatch | The body was re-serialized before verifying, or the secret was rotated. Verify on the raw body. |
| Webhook endpoint refused at save | The URL is not https. |
| Every delivery fails with a network error | The endpoint resolves to a private or loopback address, which the SSRF guard refuses. |

## Limits and known gaps

- The `REMINDER` lifecycle event exists in the contract and several adapters render it, but no code emits reminders
  today, so an unacknowledged alert is not re-notified.
- Agent-scoped rules can only be created through the API.
- Destination and webhook egress is public https only; there is no internal-host allowlist for them.
- The alert webhook envelope and the event webhook envelope are different shapes (both signed the same way).

## Related

- [Email](email.md)
- [Profiles, fallbacks and pricing](models/profiles-and-pricing.md): spend and cost alerts
- [MCP tool servers](tools/mcp.md): `mcp_unhealthy`
- [Governance and approvals](../concepts/governance.md)
- [HTTP API reference](../reference/http-api.md)
- [packages/alerts/](../../packages/alerts/)
