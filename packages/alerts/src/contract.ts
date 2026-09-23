/**
 * AlertDeliveryAdapter contract (docs/11 §7, PM/BUILD-PLAN E8.9). Adapters are
 * framework-free, take their HTTP/SMTP clients by injection and never throw
 * for delivery failures: they return a `DeliveryResult` the caller maps to
 * retry / give-up. Error strings must never contain secrets (build rule §21).
 */

/**
 * A destination kind names a delivery adapter (`SLACK`, `PAGERDUTY`, …).
 * Kinds are open: a kind exists when its adapter is registered, and the
 * registry is the only authority (the DB column is text; nothing enumerates kinds).
 */
export type DestinationKind = string;

/** Shape of a kind: upper snake case, 2–40 characters. */
export const DESTINATION_KIND_PATTERN = /^[A-Z][A-Z0-9_]{1,39}$/;

export const ALERT_KINDS = ['TECHNICAL', 'BUSINESS'] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

export const ALERT_SEVERITIES = ['INFO', 'WARNING', 'CRITICAL'] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

export const ALERT_STATUSES = ['OPEN', 'ACKNOWLEDGED', 'RESOLVED'] as const;
export type AlertStatus = (typeof ALERT_STATUSES)[number];

/** Lifecycle moment a delivery announces (mirrors alert_deliveries.event). */
export const ALERT_EVENTS = ['OPENED', 'ACKNOWLEDGED', 'RESOLVED', 'REMINDER'] as const;
export type AlertEvent = (typeof ALERT_EVENTS)[number];

/** Channel-neutral alert envelope handed to every adapter. Contains no secrets. */
export interface AlertMessage {
  alertId: string;
  /** Unique per delivery; used as an idempotency key by receivers. */
  deliveryId: string;
  event: AlertEvent;
  fingerprint: string;
  ruleId: string | null;
  ruleName: string | null;
  condition: string | null;
  kind: AlertKind;
  severity: AlertSeverity;
  status: AlertStatus;
  title: string;
  body: string;
  value: string | null;
  source: string;
  context: Readonly<Record<string, unknown>>;
  occurrences: number;
  openedAt: string;
  lastSeenAt: string;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
  resolution: string | null;
  /** Deep link into OCSO, when a public URL is configured. */
  link: string | null;
  /** Organization / deployment label shown in external messages. */
  deployment: string | null;
}

export interface DeliveryResult {
  ok: boolean;
  /** Only meaningful when `ok` is false: true for transient failures (timeouts, 429, 5xx). */
  retriable: boolean;
  /** Short, secret-free reason. */
  error?: string | undefined;
  /** Provider message/incident id when one is returned. */
  externalId?: string | undefined;
}

export type ConfigCheck<C> = { ok: true; config: C } | { ok: false; problems: string[] };

/** What the destination's secret holds; maps onto SecretStore kinds. */
export interface SecretRequirement {
  required: boolean;
  secretKind: 'WEBHOOK_SECRET' | 'API_KEY' | 'OTHER';
  /** Form label, e.g. "Incoming webhook URL". */
  label: string;
  /** What the value is, shown as the field hint and in "requires: …" errors. */
  description: string;
  /**
   * The secret applies only while these config fields hold these values
   * (email: `{ transport: 'smtp' }` — the deployment sender takes none).
   * The web form mirrors it; the API enforces it through `secretRequirement`.
   */
  when?: Readonly<Record<string, string>> | undefined;
}

/**
 * One delivery target kind. Adapters describe themselves completely: the
 * admin form (`configSchema`, `secret`), the list line (`summary`) and which
 * lifecycle events they receive (`events`) — core code never names a kind.
 */
export interface AlertDeliveryAdapter<C = unknown> {
  readonly kind: DestinationKind;
  readonly label: string;
  /** One sentence for the "Add destination" form. */
  readonly description: string;
  /**
   * Lifecycle events this destination receives; alert dispatch creates
   * deliveries only for these. Incident tools mirror every state change;
   * chat and email announce open + resolve (+ reminders) to keep channels quiet.
   */
  readonly events: readonly AlertEvent[];
  /**
   * JSON Schema (draft 2020-12, input shape) of the non-secret config, served
   * by `GET /v1/notification-destinations/kinds` and rendered by the web form.
   * `title` / `description` label the fields. A config with variants is a
   * `oneOf` whose branches pin one property with `const` (email `transport`);
   * the form shows a branch's fields while that property holds its value.
   */
  readonly configSchema: Record<string, unknown>;
  /** null = the destination never has a secret. */
  readonly secret: SecretRequirement | null;
  /** Validate and normalize admin-entered (non-secret) configuration. */
  validateConfig(config: unknown): ConfigCheck<C>;
  /** Problems with the secret value itself (e.g. webhook URL not https); empty = fine. */
  validateSecret(secret: string): string[];
  /** One line describing a validated config for destination lists ("#alerts-ops", "region EU"). Never secret. */
  summary(config: C): string;
  deliver(message: AlertMessage, config: C, secret: string | null): Promise<DeliveryResult>;
}

/** The secret requirement that applies to a validated config (see `SecretRequirement.when`). */
export function secretRequirement<C>(adapter: AlertDeliveryAdapter<C>, config: C): SecretRequirement | null {
  const secret = adapter.secret;
  if (!secret?.when) return secret;
  const values = (config ?? {}) as Record<string, unknown>;
  return Object.entries(secret.when).every(([field, value]) => values[field] === value) ? secret : null;
}

/** What `GET /v1/notification-destinations/kinds` serves for one adapter. */
export interface DestinationKindInfo {
  kind: DestinationKind;
  label: string;
  description: string;
  events: readonly AlertEvent[];
  configSchema: Record<string, unknown>;
  secret: { label: string; description: string; required: boolean; when: Readonly<Record<string, string>> | null } | null;
}

export function describeDestinationKind(adapter: AlertDeliveryAdapter): DestinationKindInfo {
  const { secret } = adapter;
  return {
    kind: adapter.kind,
    label: adapter.label,
    description: adapter.description,
    events: adapter.events,
    configSchema: adapter.configSchema,
    secret: secret ? { label: secret.label, description: secret.description, required: secret.required, when: secret.when ?? null } : null,
  };
}

export const delivered = (externalId?: string): DeliveryResult =>
  externalId === undefined ? { ok: true, retriable: false } : { ok: true, retriable: false, externalId };

export const failed = (retriable: boolean, error: string): DeliveryResult => ({ ok: false, retriable, error });
