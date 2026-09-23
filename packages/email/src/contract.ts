import type { EmailEnv, EmailSenderDeps } from './config.js';

/**
 * Transactional email (invites, password reset, email verification, sign-in
 * codes, alert notifications). One deployment-wide sender selected by
 * EMAIL_DRIVER from the registered email drivers (EmailDriverDefinition in
 * ./drivers.ts; first party: `resend`, `smtp`, `log`). The name is open: the
 * composition root validates it against the registry.
 */
export type EmailDriver = string;

export interface EmailMessage {
  to: string | readonly string[];
  subject: string;
  html: string;
  text: string;
  replyTo?: string | undefined;
  /** Low-cardinality labels for the provider's dashboards, e.g. { kind: 'invite' }. */
  tags?: Readonly<Record<string, string>> | undefined;
  /** Same key → the provider sends at most once (retries are safe). */
  idempotencyKey?: string | undefined;
}

export interface EmailSendResult {
  /** Provider message id when the provider returns one. */
  id: string | null;
}

export interface EmailSender {
  readonly driver: EmailDriver;
  /** Sender address used for every message (EMAIL_FROM). */
  readonly from: string;
  /**
   * False when messages never leave the process (a development driver that
   * only logs them); callers then hand links out of band. Omitted = delivers.
   */
  readonly delivers?: boolean | undefined;
  /** Throws EmailSendError; `retriable` tells callers whether a retry can help. */
  send(message: EmailMessage): Promise<EmailSendResult>;
}

/**
 * Coarse failure class for operators and the Settings test button:
 * auth = key/credentials/domain rejected (fix the deployment config),
 * validation = the message itself was refused, rate_limited = 429 / quota,
 * unavailable = provider 5xx or busy, network = timeout / connection failure.
 */
export type EmailErrorCategory = 'auth' | 'validation' | 'rate_limited' | 'unavailable' | 'network' | 'unknown';

export class EmailSendError extends Error {
  constructor(
    message: string,
    readonly retriable: boolean,
    readonly status: number | null = null,
    readonly category: EmailErrorCategory = 'unknown',
  ) {
    super(message);
    this.name = 'EmailSendError';
  }
}

/** A rendered email: subject + HTML + plain-text alternative. */
export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

/**
 * What a driver's `resolve` step gets besides the environment: the validated
 * sender address and helpers that keep secret handling and error reporting
 * uniform across drivers.
 */
export interface EmailDriverContext {
  /** EMAIL_FROM after validation; null when unset or invalid. */
  readonly from: string | null;
  /** Per-request timeout the driver should apply. */
  readonly timeoutMs: number;
  /**
   * A secret from `value`, else from the file `file` names (trimmed). Records
   * a problem for a missing, unreadable or empty file; never echoes content.
   */
  secret(value: string | undefined, file: string | undefined, name: string): string | null;
  /** Record a configuration problem. Start-up fails listing every problem; never include secret values. */
  problem(message: string): void;
}

/**
 * An email driver: registered by name, selected by EMAIL_DRIVER. `resolve`
 * validates its settings and secrets once at start-up; `create` builds the
 * deployment-wide sender from the result.
 */
export interface EmailDriverDefinition<Options = unknown> {
  /** EMAIL_DRIVER value that selects this driver, e.g. `resend`. */
  readonly name: string;
  /** Display name for Settings → Email, e.g. `Resend`. */
  readonly label: string;
  /**
   * False for a driver that never hands a message to anyone (development);
   * its sender reports `delivers: false` too. Production refuses it unless
   * EMAIL_ALLOW_LOG_IN_PRODUCTION=true, and it needs no EMAIL_FROM.
   */
  readonly delivers: boolean;
  /** Validate this driver's settings and resolve its secrets; null after recording a problem. */
  resolve(env: EmailEnv, ctx: EmailDriverContext): Options | null;
  create(options: Options, sender: { from: string; replyTo: string | null }, deps: EmailSenderDeps): EmailSender;
}
