import type { EmailSender } from './email.js';

/**
 * The alert destination contract. A destination adapter delivers OCSO's
 * technical and business alerts somewhere (a chat tool, an incident tool, a
 * webhook). Adapters never throw for delivery failures: they return a
 * `DeliveryResult` OCSO maps to retry / give-up. Error strings never contain
 * secrets.
 */

/** A destination kind (`SLACK`, `PAGERDUTY`…): upper snake case, see `DESTINATION_KIND_PATTERN`. */
export type DestinationKind = string;

export type AlertKind = 'TECHNICAL' | 'BUSINESS';
export type AlertSeverity = 'INFO' | 'WARNING' | 'CRITICAL';
export type AlertStatus = 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED';

/** Lifecycle moment a delivery announces. */
export const ALERT_EVENTS = ['OPENED', 'ACKNOWLEDGED', 'RESOLVED', 'REMINDER'] as const;
export type AlertEvent = (typeof ALERT_EVENTS)[number];

/** Channel-neutral alert envelope handed to every adapter. Contains no secrets. */
export interface AlertMessage {
  alertId: string;
  /** Unique per delivery; an idempotency key for receivers. */
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

/** What the destination's single secret holds. */
export interface SecretRequirement {
  required: boolean;
  secretKind: 'WEBHOOK_SECRET' | 'API_KEY' | 'OTHER';
  /** Form label, e.g. "Incoming webhook URL". */
  label: string;
  /** What the value is, shown as the field hint. */
  description: string;
  /** The secret applies only while these config fields hold these values. */
  when?: Readonly<Record<string, string>> | undefined;
}

/** One delivery target kind. Adapters describe themselves completely; core never names a kind. */
export interface AlertDeliveryAdapter<C = unknown> {
  readonly kind: DestinationKind;
  readonly label: string;
  /** One sentence for the "Add destination" form. */
  readonly description: string;
  /** Lifecycle events this destination receives (non-empty subset of `ALERT_EVENTS`). */
  readonly events: readonly AlertEvent[];
  /** JSON Schema (draft 2020-12, input shape) of the non-secret config; variants are `oneOf` branches pinned by `const`. */
  readonly configSchema: Record<string, unknown>;
  /** null = the destination never has a secret. */
  readonly secret: SecretRequirement | null;
  /** Validate and normalize admin-entered (non-secret) configuration. */
  validateConfig(config: unknown): ConfigCheck<C>;
  /** Problems with the secret value itself; empty = fine. */
  validateSecret(secret: string): string[];
  /** One line describing a validated config for destination lists. Never secret. */
  summary(config: C): string;
  deliver(message: AlertMessage, config: C, secret: string | null): Promise<DeliveryResult>;
}

/** The fetch destination adapters are given (OCSO's SSRF-guarded egress). */
export type FetchFn = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** SMTP connection settings handed to the transport factory. */
export interface SmtpTransportOptions {
  host: string;
  port: number;
  secure: boolean;
  requireTLS: boolean;
  auth?: { user: string; pass: string } | undefined;
  timeoutMs: number;
}

export interface OutgoingMail {
  from: string;
  to: string[];
  subject: string;
  text: string;
  html: string;
  headers: Record<string, string>;
  replyTo?: string | undefined;
  messageId?: string | undefined;
}

export interface MailTransport {
  sendMail(mail: OutgoingMail): Promise<{ messageId?: string | undefined }>;
  close(): void;
}

export type MailTransportFactory = (options: SmtpTransportOptions) => MailTransport;

/** Everything a destination adapter gets from OCSO. */
export interface DeliveryAdapterDeps {
  fetch: FetchFn;
  /** SMTP transport factory. */
  mailTransport: MailTransportFactory;
  /** The deployment's own email sender, when one is configured. */
  emailSender?: EmailSender | null | undefined;
  /** Per-request timeout for HTTP and SMTP. Default 10 s. */
  timeoutMs?: number | undefined;
  now?: (() => Date) | undefined;
}

export const delivered = (externalId?: string): DeliveryResult =>
  externalId === undefined ? { ok: true, retriable: false } : { ok: true, retriable: false, externalId };

export const failed = (retriable: boolean, error: string): DeliveryResult => ({ ok: false, retriable, error });
