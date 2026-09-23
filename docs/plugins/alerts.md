# Alerts: delivery destinations and rule conditions

Alerts have two extension points. A **delivery destination** is where an alert goes (Slack, PagerDuty,
…). A **rule condition** (an evaluator) decides when an alert fires. Both are registries; the core owns
the rule engine, deduplication, the open → acknowledged → resolved lifecycle, audiences and retries.

Background: [docs/11-OBSERVABILITY-ALERTS-AND-ANALYTICS.md](../11-OBSERVABILITY-ALERTS-AND-ANALYTICS.md).
Operator view: [docs/operations/setup-guide.md §7](../operations/setup-guide.md#7-alerts-and-webhooks).

## Delivery destinations

Shipped in `packages/alerts/src/adapters/`: `IN_APP`, `EMAIL` (the deployment's email sender, or the
destination's own SMTP relay), `SLACK` (incoming webhook), `TEAMS`, `WEBHOOK` (HMAC-signed) and
`PAGERDUTY`.

Destination kinds are open strings (upper snake case). A kind exists when its adapter is registered:
the registry is the only authority, and nothing in the core, the API or the web app lists kinds. The
adapter describes itself completely — its form, its secret, its list line and the lifecycle events it
receives.

### The contract

`packages/alerts/src/contract.ts`, trimmed:

```ts
export type DestinationKind = string; // DESTINATION_KIND_PATTERN: upper snake case

export interface AlertDeliveryAdapter<C = unknown> {
  readonly kind: DestinationKind;
  readonly label: string;
  /** One sentence for the "Add destination" form. */
  readonly description: string;
  /** Lifecycle events this destination receives; dispatch creates deliveries only for these. */
  readonly events: readonly AlertEvent[];   // 'OPENED' | 'ACKNOWLEDGED' | 'RESOLVED' | 'REMINDER'
  /** JSON Schema (draft 2020-12, input shape) of the non-secret config; the web form renders it. */
  readonly configSchema: Record<string, unknown>;
  /** null = the destination never has a secret. */
  readonly secret: SecretRequirement | null;
  validateConfig(config: unknown): ConfigCheck<C>;
  /** Problems with the secret value itself (e.g. webhook URL not https); empty = fine. */
  validateSecret(secret: string): string[];
  /** One line describing a validated config for destination lists. Never secret. */
  summary(config: C): string;
  deliver(message: AlertMessage, config: C, secret: string | null): Promise<DeliveryResult>;
}

export interface SecretRequirement {
  required: boolean;
  secretKind: 'WEBHOOK_SECRET' | 'API_KEY' | 'OTHER';
  label: string;          // form label, e.g. "Incoming webhook URL"
  description: string;    // field hint and "requires: …" errors
  /** Applies only while config fields hold these values, e.g. { transport: 'smtp' }. */
  when?: Readonly<Record<string, string>>;
}
```

`AlertMessage` is channel-neutral and holds no secrets: title, body, severity, status, lifecycle event,
source, context, and a deep link into OCSO. `deliver` never throws for a delivery failure. It returns
`{ ok: false, retriable, error }` with a short, secret-free reason.

**The config form.** `configSchema` is usually `z.toJSONSchema(Config, { io: 'input' })`. Field labels
come from `title` and hints from `description` (`.meta({ title, description })` in zod); defaults show as
placeholders and a blank field is left out so your default applies. A config with variants is a
`oneOf` whose branches pin one property with `const` — `z.discriminatedUnion` produces exactly that. The
form then offers a picker for that property (labelled by its `title`, options by each branch's
`title`) and shows the chosen branch's fields. Email uses this for `transport` (`deployment` | `smtp`),
with `secret.when = { transport: 'smtp' }` so the SMTP password field only appears for the relay. Leave
options the form should not offer out of the schema (email's `secure` is API-only; it follows the port).

### Registration

Add the adapter factory to the `@ocso/alerts` entry of `FIRST_PARTY_PLUGINS`
(`packages/bootstrap/src/first-party.ts`, the composition root):

```ts
{
  name: '@ocso/alerts',
  alertDestinations: [createInAppAdapter, createEmailAdapter, createSlackAdapter, createTeamsAdapter, createWebhookAdapter, createPagerDutyAdapter],
},
```

The api and the worker build the registry with `createAlertDeliveryRegistry` (`packages/bootstrap`),
which hands every factory an SSRF-guarded `fetch` and the deployment's email sender
(`createDefaultDeliveryRegistry` in `packages/alerts` does the same for tests). `register` rejects a
malformed or duplicate kind and events outside the lifecycle. The same registry instance is given to the alert engine, `AlertService` and
`AlertRuleService` (as `DestinationEventRouting`, i.e. `registry.receives(kind, event)`), to
`NotificationDestinationService` and to `AlertDeliveryService`.

### What the core does for you

- Serves every registered kind at `GET /v1/notification-destinations/kinds` (label, description,
  events, `configSchema`, the secret field; never a secret). Readable by destination managers and rule
  editors. The web destination dialog renders from it with the same JSON Schema renderer as the channel
  settings form — a new adapter needs no web change.
- Validates the kind against the registry on create (`unsupported_destination_kind` otherwise), stores
  the non-secret config after `validateConfig`, and the secret (webhook URL, routing key, SMTP password)
  in the SecretStore. Secrets are never shown again.
- Returns each destination's config as your adapter normalizes it, plus `summary(config)` for the list.
- Creates one delivery per destination whose adapter lists the lifecycle event, and runs it on the
  `alert.deliver` queue. Transient failures retry with backoff, up to 6 attempts by default; deliveries
  lost between commit and publish are re-queued by a scheduled task. Destinations whose kind is no longer
  registered receive nothing.
- Gives each destination a **Test** button.

### Skeleton

`adapters/slack.ts` is a short, complete example:

```ts
const AcmeConfig = z.object({ room: z.string().trim().max(80).optional().meta({ title: 'Room', description: 'display only' }) }).strict();

export function createAcmeAdapter(deps: Pick<DeliveryAdapterDeps, 'fetch' | 'timeoutMs'>): AlertDeliveryAdapter<z.output<typeof AcmeConfig>> {
  return {
    kind: 'ACME',
    label: 'Acme',
    description: 'Posts alerts to an Acme room through its webhook.',
    events: ['OPENED', 'RESOLVED', 'REMINDER'],
    configSchema: z.toJSONSchema(AcmeConfig, { io: 'input' }) as Record<string, unknown>,
    secret: { required: true, secretKind: 'WEBHOOK_SECRET', label: 'Webhook URL', description: 'Acme webhook URL' },
    validateConfig: (config) => checkConfig(AcmeConfig, config),
    validateSecret: (secret) => httpsUrlProblems(secret, 'Acme webhook URL'),
    summary: (config) => config.room ?? 'webhook stored as a secret',
    async deliver(message, _config, secret) {
      if (!secret) return { ok: false, retriable: false, error: 'webhook URL not configured' };
      const outcome = await postJson(deps.fetch, { url: secret, body: JSON.stringify(renderAcme(message)), timeoutMs: deps.timeoutMs });
      return resultFromHttp(outcome, (_status, text) => safeToken(redactSecrets(text, [secret])));
    },
  };
}
```

Tests to copy: `packages/alerts/test/slack.test.ts` (payload shape and failure mapping with a fake
`fetch`) and `registry.test.ts` (open kinds, events, descriptions, summaries);
`apps/web/test/unit/system/destination-email.test.ts` renders every registered adapter's schema through
the web form; `packages/application/test/alerts-config.int.test.ts` for destination administration on
PostgreSQL.

### Limits today

- Adapters are compiled in and listed in `FIRST_PARTY_PLUGINS`; there is no loader yet.
- The form renderer understands flat objects, nested objects as field groups, string lists, and one
  level of `oneOf` variants pinned by a `const` property. Deeper conditionals are not rendered.

## Rule conditions (evaluators)

Shipped in `packages/application/src/alerts/evaluators/`, grouped as technical (worker floor, queue age,
provider error rate, latency and time-to-first-token p95, MCP health, token and cost spikes, sign-in
failures, database health) and business (escalation rate, SLA and resolution-SLA breaches, repeated
failure topics, tool failure rate, CSAT, conversion drop).

### The contract

`packages/application/src/alerts/evaluators/contract.ts`, trimmed:

```ts
export interface EvaluatorDefinition<S extends z.ZodType<Record<string, unknown>>> {
  condition: string;
  label: string;
  kinds: readonly AlertKind[];          // TECHNICAL and/or BUSINESS
  /** Whether a rule for this condition may be bound to one virtual agent. */
  agentScoped: boolean;
  /** Plain-language method (docs/11 §3: explicit and auditable, no opaque scores). */
  method: string;
  params: S;
  evaluate(ctx: EvaluationContext<z.output<S>>): Promise<Observation[]>;
}
```

`evaluate` gets the database, the time window, the rule and its parsed params, and returns one
`Observation` per scope it looked at (a provider, an agent, a queue): whether it is firing, a stable
title, a body a human can read, the measured value, and correlation context. Wrap the definition with
`defineEvaluator`.

### Registration

Add the evaluator to `BUILT_IN_EVALUATORS` in `packages/application/src/alerts/evaluators/registry.ts`.
Conditions are plain strings, so there is no kinds constant to update.

### What the core does for you

- The worker's scheduler leader runs every enabled rule every 30 seconds.
- Each observation is fingerprinted by rule and scope. A firing observation opens an alert, or bumps
  the open one. A recently resolved one is not reopened inside the rule's dedupe window. When the rule
  has auto-resolve on, an open alert whose scope stops firing is resolved.
- Rule params are validated with your zod schema, and `GET /v1/alert-rules/conditions` publishes the
  JSON Schema, label, kinds and method. The rule dialog in the web app renders the params from it, with
  no per-condition UI code.
- Alerts are shown to the roles in the rule's audience. Technical and business alerts each have their
  own read and manage permissions, and an alert about one agent is shown only to people who can read
  that agent (for a Head or Lead, their teams' agents).

Tests to copy: `packages/application/test/alerts-evaluators-technical.int.test.ts` and
`alerts-evaluators-business.int.test.ts` (seed rows, evaluate, assert observations), and
`alerts-lifecycle.int.test.ts` for open, acknowledge and resolve.

A spend-budget condition is being added as this is written.
