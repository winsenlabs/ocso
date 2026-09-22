/**
 * Transactional email (invites, password reset, email verification, sign-in
 * codes, alert notifications). One deployment-wide sender selected by
 * EMAIL_DRIVER: `resend` (Resend HTTPS API), `smtp` (any SMTP relay) or `log`
 * (development/tests: nothing leaves the process).
 */
export type EmailDriver = 'resend' | 'smtp' | 'log';

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
  /** Throws EmailSendError; `retriable` tells callers whether a retry can help. */
  send(message: EmailMessage): Promise<EmailSendResult>;
}

export class EmailSendError extends Error {
  constructor(
    message: string,
    readonly retriable: boolean,
    readonly status: number | null = null,
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
