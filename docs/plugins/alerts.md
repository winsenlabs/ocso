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

### The contract

`packages/alerts/src/contract.ts`, trimmed:

```ts
export interface AlertDeliveryAdapter<C = unknown> {
  readonly kind: DestinationKind;
  readonly label: string;
  /** null = the destination never has a secret. */
  readonly secret: SecretRequirement | null;
  /** Validate and normalize admin-entered (non-secret) configuration. */
  validateConfig(config: unknown): ConfigCheck<C>;
  /** Secret requirement for one validated config, when it depends on the config. */
  secretFor?(config: C): SecretRequirement | null;
  /** Problems with the secret value itself (e.g. webhook URL not https); empty = fine. */
  validateSecret(secret: string): string[];
  deliver(message: AlertMessage, config: C, secret: string | null): Promise<DeliveryResult>;
}
```

`AlertMessage` is channel-neutral and holds no secrets: title, body, severity, status, lifecycle event,
source, context, and a deep link into OCSO. `deliver` never throws for a delivery failure. It returns
`{ ok: false, retriable, error }` with a short, secret-free reason.

### Registration

`packages/alerts/src/registry.ts`:

```ts
return new AlertDeliveryRegistry()
  .register(createInAppAdapter())
  .register(createEmailAdapter(deps))
  .register(createSlackAdapter(deps))
  .register(createTeamsAdapter(deps))
  .register(createWebhookAdapter(deps))
  .register(createPagerDutyAdapter(deps));
```

The api and the worker call `createDefaultDeliveryRegistry` with an SSRF-guarded `fetch` and the
deployment's email sender. The kind must also be in `DESTINATION_KINDS`, and in `DESTINATION_EVENTS`,
which says which lifecycle events each kind receives (chat and email: opened, resolved, reminder;
PagerDuty and webhooks: every change).

### What the core does for you

- Stores the destination's non-secret config after `validateConfig`, and the secret (webhook URL,
  routing key, SMTP password) in the SecretStore. Secrets are never shown again.
- Creates one delivery per destination and lifecycle event, and runs it on the `alert.deliver` queue.
  Transient failures retry with backoff, up to 6 attempts by default; deliveries lost between commit and
  publish are re-queued by a scheduled task.
- Gives each destination a **Test** button.

### Skeleton

`adapters/slack.ts` is a short, complete example:

```ts
export function createAcmeAdapter(deps: Pick<DeliveryAdapterDeps, 'fetch' | 'timeoutMs'>): AlertDeliveryAdapter<AcmeConfig> {
  return {
    kind: 'ACME', // add to DESTINATION_KINDS and DESTINATION_EVENTS first
    label: 'Acme',
    secret: { required: true, secretKind: 'WEBHOOK_SECRET', description: 'Acme webhook URL' },
    validateConfig: (config) => checkConfig(AcmeConfig, config),
    validateSecret: (secret) => httpsUrlProblems(secret, 'Acme webhook URL'),
    async deliver(message, _config, secret) {
      if (!secret) return { ok: false, retriable: false, error: 'webhook URL not configured' };
      const outcome = await postJson(deps.fetch, { url: secret, body: JSON.stringify(renderAcme(message)), timeoutMs: deps.timeoutMs });
      return resultFromHttp(outcome, (_status, text) => safeToken(redactSecrets(text, [secret])));
    },
  };
}
```

Tests to copy: `packages/alerts/test/slack.test.ts` (payload shape and failure mapping with a fake
`fetch`) and `registry.test.ts`; `packages/application/test/alerts-config.int.test.ts` for destination
administration on PostgreSQL.

### Limits today

- `DESTINATION_KINDS` is a closed union; destination input is validated with `z.enum` against it
  (`packages/application/src/alerts/destinations.ts`).
- The contract has no config schema or descriptor, so the destination form in the web app is written
  by hand per kind (`apps/web/components/alerts/destination-form.ts`, `alerts-meta.ts`,
  `apps/web/lib/api/alerts.ts`). A new destination needs a form entry there.

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
  that agent (for a CS Lead, their teams' agents).

Tests to copy: `packages/application/test/alerts-evaluators-technical.int.test.ts` and
`alerts-evaluators-business.int.test.ts` (seed rows, evaluate, assert observations), and
`alerts-lifecycle.int.test.ts` for open, acknowledge and resolve.

A spend-budget condition is being added as this is written.
