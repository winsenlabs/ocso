import type { MailTransportFactory } from './alerts.js';

/**
 * The email driver contract. OCSO sends its transactional email (invites,
 * password resets, sign-in codes, alert notifications) through one
 * deployment-wide sender, selected by `EMAIL_DRIVER=<name>` from the
 * registered drivers.
 *
 * `EmailEnv` lists only the variables OCSO itself parses. A plugin driver
 * reads its own settings from `process.env` in `resolve` (OCSO drops unknown
 * keys from its parsed environment) and reports problems with `ctx.problem`.
 */

export type EmailDriver = string;

export interface EmailMessage {
  to: string | readonly string[];
  subject: string;
  html: string;
  text: string;
  replyTo?: string | undefined;
  /** Low-cardinality labels for the provider's dashboards. */
  tags?: Readonly<Record<string, string>> | undefined;
  /** Same key → the provider sends at most once. */
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
  /** False when messages never leave the process (a development driver). Omitted = delivers. */
  readonly delivers?: boolean | undefined;
  send(message: EmailMessage): Promise<EmailSendResult>;
}

export type EmailErrorCategory = 'auth' | 'validation' | 'rate_limited' | 'unavailable' | 'network' | 'unknown';

/** The deployment environment OCSO passes to `resolve` (the keys OCSO parses; see the note above). */
export interface EmailEnv {
  NODE_ENV?: string | undefined;
  EMAIL_DRIVER?: EmailDriver | undefined;
  EMAIL_FROM?: string | undefined;
  EMAIL_REPLY_TO?: string | undefined;
  EMAIL_ALLOW_LOG_IN_PRODUCTION?: boolean | undefined;
  RESEND_API_KEY?: string | undefined;
  RESEND_API_KEY_FILE?: string | undefined;
  SMTP_URL?: string | undefined;
  SMTP_HOST?: string | undefined;
  SMTP_PORT?: number | undefined;
  SMTP_SECURE?: boolean | undefined;
  SMTP_REQUIRE_TLS?: boolean | undefined;
  SMTP_USER?: string | undefined;
  SMTP_PASSWORD?: string | undefined;
  SMTP_PASSWORD_FILE?: string | undefined;
}

export type EmailFetch = (input: string, init: RequestInit) => Promise<Response>;

/** What resolving the configuration gets besides the environment. */
export interface EmailResolveDeps {
  readFile?: ((path: string) => string) | undefined;
  timeoutMs?: number | undefined;
  drivers?: readonly EmailDriverDefinition[] | undefined;
}

/** What `create` gets from OCSO. */
export interface EmailSenderDeps extends EmailResolveDeps {
  fetch?: EmailFetch | undefined;
  transportFactory?: MailTransportFactory | undefined;
  /** Log sink (one line per message) for development drivers. */
  log?: ((line: string) => void) | undefined;
  resendBaseUrl?: string | undefined;
}

/** What a driver's `resolve` step gets besides the environment. */
export interface EmailDriverContext {
  /** EMAIL_FROM after validation; null when unset or invalid. */
  readonly from: string | null;
  /** Per-request timeout the driver should apply. */
  readonly timeoutMs: number;
  /** A secret from `value`, else from the file `file` names (trimmed); records a problem when missing. */
  secret(value: string | undefined, file: string | undefined, name: string): string | null;
  /** Record a configuration problem. Start-up fails listing every problem; never include secret values. */
  problem(message: string): void;
}

/** An email driver: registered by name, selected by EMAIL_DRIVER. */
export interface EmailDriverDefinition<Options = unknown> {
  /** EMAIL_DRIVER value that selects this driver (`DRIVER_NAME_PATTERN`). */
  readonly name: string;
  /** Display name for Settings → Email. */
  readonly label: string;
  /** False for a driver that never hands a message to anyone (development). */
  readonly delivers: boolean;
  /** Validate settings and resolve secrets once at start-up; null after recording a problem. */
  resolve(env: EmailEnv, ctx: EmailDriverContext): Options | null;
  create(options: Options, sender: { from: string; replyTo: string | null }, deps: EmailSenderDeps): EmailSender;
}
