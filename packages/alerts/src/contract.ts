/**
 * AlertDeliveryAdapter contract (docs/11 §7, PM/BUILD-PLAN E8.9). Adapters are
 * framework-free, take their HTTP/SMTP clients by injection and never throw
 * for delivery failures: they return a `DeliveryResult` the caller maps to
 * retry / give-up. Error strings must never contain secrets (build rule §21).
 */

export const DESTINATION_KINDS = ['IN_APP', 'EMAIL', 'SLACK', 'TEAMS', 'WEBHOOK', 'PAGERDUTY'] as const;
export type DestinationKind = (typeof DESTINATION_KINDS)[number];

export const ALERT_KINDS = ['TECHNICAL', 'BUSINESS'] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

export const ALERT_SEVERITIES = ['INFO', 'WARNING', 'CRITICAL'] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

export const ALERT_STATUSES = ['OPEN', 'ACKNOWLEDGED', 'RESOLVED'] as const;
export type AlertStatus = (typeof ALERT_STATUSES)[number];

/** Lifecycle moment a delivery announces (mirrors alert_deliveries.event). */
export const ALERT_EVENTS = ['OPENED', 'ACKNOWLEDGED', 'RESOLVED', 'REMINDER'] as const;
export type AlertEvent = (typeof ALERT_EVENTS)[number];

/**
 * Which lifecycle events each destination kind receives. Incident tools
 * (PagerDuty, generic webhooks) mirror every state change; chat and email
 * announce open + resolve only, to keep channels quiet.
 */
export const DESTINATION_EVENTS: Readonly<Record<DestinationKind, readonly AlertEvent[]>> = {
  IN_APP: ['OPENED'],
  EMAIL: ['OPENED', 'RESOLVED', 'REMINDER'],
  SLACK: ['OPENED', 'RESOLVED', 'REMINDER'],
  TEAMS: ['OPENED', 'RESOLVED', 'REMINDER'],
  WEBHOOK: ['OPENED', 'ACKNOWLEDGED', 'RESOLVED', 'REMINDER'],
  PAGERDUTY: ['OPENED', 'ACKNOWLEDGED', 'RESOLVED', 'REMINDER'],
};

export function destinationReceives(kind: DestinationKind, event: AlertEvent): boolean {
  return DESTINATION_EVENTS[kind].includes(event);
}

export function isDestinationKind(value: string): value is DestinationKind {
  return (DESTINATION_KINDS as readonly string[]).includes(value);
}

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
  description: string;
}

export interface AlertDeliveryAdapter<C = unknown> {
  readonly kind: DestinationKind;
  readonly label: string;
  /** null = the destination never has a secret. */
  readonly secret: SecretRequirement | null;
  /** Validate and normalize admin-entered (non-secret) configuration. */
  validateConfig(config: unknown): ConfigCheck<C>;
  /**
   * Secret requirement for one validated config, when it depends on the
   * config (email: SMTP transport takes a password, the deployment sender
   * none). Absent = `secret` applies to every config.
   */
  secretFor?(config: C): SecretRequirement | null;
  /** Problems with the secret value itself (e.g. webhook URL not https); empty = fine. */
  validateSecret(secret: string): string[];
  deliver(message: AlertMessage, config: C, secret: string | null): Promise<DeliveryResult>;
}

/** The secret requirement that applies to a validated config (see `secretFor`). */
export function secretRequirement<C>(adapter: AlertDeliveryAdapter<C>, config: C): SecretRequirement | null {
  return adapter.secretFor ? adapter.secretFor(config) : adapter.secret;
}

export const delivered = (externalId?: string): DeliveryResult =>
  externalId === undefined ? { ok: true, retriable: false } : { ok: true, retriable: false, externalId };

export const failed = (retriable: boolean, error: string): DeliveryResult => ({ ok: false, retriable, error });
