import { createHash } from 'node:crypto';
import { mailboxAddress } from './address.js';
import { EmailSendError, type EmailMessage, type EmailSender, type EmailSendResult } from './contract.js';
import { classifySmtpError, nodemailerTransportFactory, type MailTransport, type MailTransportFactory, type SmtpTransportOptions } from './smtp-transport.js';

export interface SmtpSenderOptions {
  from: string;
  replyTo?: string | null | undefined;
  smtp: SmtpTransportOptions;
  /** Defaults to nodemailer; tests inject a fake. */
  transportFactory?: MailTransportFactory | undefined;
}

/**
 * SMTP driver over nodemailer (any relay: SES SMTP, Postmark, Mailgun,
 * Resend SMTP, a corporate relay). One transport per sender, created lazily.
 * SMTP has no idempotency: a stable Message-ID derived from the key lets
 * receiving servers drop a duplicate after a retry.
 */
export class SmtpEmailSender implements EmailSender {
  readonly driver = 'smtp' as const;
  readonly from: string;
  private transport: MailTransport | null = null;

  constructor(private readonly options: SmtpSenderOptions) {
    this.from = options.from;
  }

  async send(message: EmailMessage): Promise<EmailSendResult> {
    const to = [message.to].flat();
    if (to.length === 0) throw new EmailSendError('email has no recipients', false, null, 'validation');
    const replyTo = message.replyTo ?? this.options.replyTo ?? undefined;
    const headers: Record<string, string> = {};
    if (message.tags?.['kind']) headers['X-OCSO-Email-Kind'] = message.tags['kind'].replace(/[^\w.-]/g, '_').slice(0, 64);
    this.transport ??= (this.options.transportFactory ?? nodemailerTransportFactory)(this.options.smtp);
    try {
      const info = await this.transport.sendMail({
        from: this.from,
        to,
        subject: message.subject.replace(/[\r\n]+/g, ' '),
        text: message.text,
        html: message.html,
        headers,
        replyTo,
        messageId: message.idempotencyKey ? stableMessageId(message.idempotencyKey, this.from) : undefined,
      });
      return { id: info.messageId ?? null };
    } catch (error) {
      const c = classifySmtpError(error);
      // Drop the connection after a failure; the next send reconnects.
      this.close();
      throw new EmailSendError(c.error, c.retriable, c.status, c.category);
    }
  }

  close(): void {
    this.transport?.close();
    this.transport = null;
  }
}

/** `<3f2a…@example.com>` — same key, same Message-ID; domain from the sender address. */
export function stableMessageId(key: string, from: string): string {
  const domain = mailboxAddress(from).split('@')[1] ?? 'ocso.invalid';
  return `<${createHash('sha256').update(key).digest('hex').slice(0, 32)}@${domain}>`;
}
