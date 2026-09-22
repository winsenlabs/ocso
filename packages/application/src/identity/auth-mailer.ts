import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { deploymentSettings, type Db } from '@ocso/db';
import {
  EmailSendError,
  inviteEmail,
  passwordChangedEmail,
  passwordResetEmail,
  type EmailSender,
  type RenderedEmail,
  type TemplateContext,
} from '@ocso/email';

export type MailOutcome = { delivered: true } | { delivered: false; error: string; retriable: boolean };

export interface AuthMailerDeps {
  db: Db;
  sender: EmailSender;
  /** OCSO_PUBLIC_URL: links in emails land on the web app. */
  publicUrl: string;
  /** Delivery failures are reported here (never with the link or token). */
  onError?: ((kind: string, err: unknown) => void) | undefined;
}

/**
 * Authentication emails (ADR-025). Better Auth never sends mail itself: its
 * callbacks and OCSO's invite flow call this, which renders @ocso/email
 * templates and sends through the deployment's EMAIL_SENDER.
 */
export class AuthMailer {
  constructor(private readonly deps: AuthMailerDeps) {}

  /** True when email actually leaves the process; false for a non-delivering driver (log). */
  get delivers(): boolean {
    return this.deps.sender.delivers !== false;
  }

  get sender(): EmailSender {
    return this.deps.sender;
  }

  /** Link to a web page carrying a one-time token, e.g. /invite?token=… */
  link(path: '/invite' | '/reset-password', token: string): string {
    const url = new URL(path, this.deps.publicUrl);
    url.searchParams.set('token', token);
    return url.toString();
  }

  async sendInvite(input: { to: string; name: string; roleLabel: string; inviterName: string; token: string; expiresAt: Date }): Promise<MailOutcome> {
    const ctx = await this.context();
    const email = inviteEmail({
      ...ctx,
      inviterName: input.inviterName,
      recipientEmail: input.to,
      recipientName: input.name,
      roleLabel: input.roleLabel,
      acceptUrl: this.link('/invite', input.token),
      expiresAt: input.expiresAt,
    });
    return this.send('invite', input.to, email, input.token);
  }

  async sendPasswordReset(input: { to: string; name: string; token: string; expiresAt: Date }): Promise<MailOutcome> {
    const ctx = await this.context();
    const email = passwordResetEmail({ ...ctx, recipientName: input.name, resetUrl: this.link('/reset-password', input.token), expiresAt: input.expiresAt });
    return this.send('password_reset', input.to, email, input.token);
  }

  async sendPasswordChanged(input: { to: string; name: string; changedAt: Date }): Promise<MailOutcome> {
    const ctx = await this.context();
    const email = passwordChangedEmail({ ...ctx, recipientName: input.name, changedAt: input.changedAt, resetUrl: new URL('/forgot-password', this.deps.publicUrl).toString() });
    return this.send('password_changed', input.to, email, `${input.to}:${input.changedAt.toISOString()}`);
  }

  private async context(): Promise<TemplateContext> {
    const [row] = await this.deps.db
      .select({ org: deploymentSettings.orgName, timeZone: deploymentSettings.timezone })
      .from(deploymentSettings)
      .where(eq(deploymentSettings.id, 1))
      .limit(1);
    return { org: row?.org ?? 'OCSO', timeZone: row?.timeZone ?? 'UTC' };
  }

  private async send(kind: string, to: string, email: RenderedEmail, idempotencySeed: string): Promise<MailOutcome> {
    // The key is derived from the one-time token, so a retried send never mails twice and the token is not exposed.
    const idempotencyKey = `ocso-${kind}-${createHash('sha256').update(idempotencySeed).digest('hex').slice(0, 32)}`;
    try {
      await this.deps.sender.send({ to, subject: email.subject, html: email.html, text: email.text, tags: { kind }, idempotencyKey });
      return { delivered: true };
    } catch (err) {
      this.deps.onError?.(kind, err);
      if (err instanceof EmailSendError) return { delivered: false, error: err.message, retriable: err.retriable };
      return { delivered: false, error: 'The email could not be sent', retriable: true };
    }
  }
}
