import { createTransport } from 'nodemailer';
import type { EmailErrorCategory } from './contract.js';

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
  /** Stable Message-ID (derived from the idempotency key) so receivers can drop duplicates. */
  messageId?: string | undefined;
}

/** The subset of a nodemailer transporter the senders use. */
export interface MailTransport {
  sendMail(mail: OutgoingMail): Promise<{ messageId?: string | undefined }>;
  close(): void;
}

export type MailTransportFactory = (options: SmtpTransportOptions) => MailTransport;

/** Production factory: a nodemailer SMTP transport with bounded timeouts. */
export const nodemailerTransportFactory: MailTransportFactory = (options) => {
  const transporter = createTransport({
    host: options.host,
    port: options.port,
    secure: options.secure,
    requireTLS: options.requireTLS,
    ...(options.auth ? { auth: options.auth } : {}),
    connectionTimeout: options.timeoutMs,
    greetingTimeout: options.timeoutMs,
    socketTimeout: options.timeoutMs,
  });
  return {
    async sendMail(mail) {
      const { replyTo, messageId, ...rest } = mail;
      const info = await transporter.sendMail({ ...rest, ...(replyTo ? { replyTo } : {}), ...(messageId ? { messageId } : {}) });
      return { messageId: info.messageId };
    },
    close: () => transporter.close(),
  };
};

/** Nodemailer error codes that indicate a transient condition. */
const TRANSIENT_CODES: ReadonlySet<string> = new Set(['ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'EDNS', 'EPROXY', 'ECONNRESET', 'ECONNREFUSED', 'EMAXLIMIT']);

/**
 * Classify an SMTP failure without echoing server text (which can include
 * account names). SMTP 4xx replies are transient by definition; 5xx are permanent.
 */
export function classifySmtpError(error: unknown): { retriable: boolean; error: string; status: number | null; category: EmailErrorCategory } {
  const e = (error ?? {}) as { code?: unknown; responseCode?: unknown };
  const code = typeof e.code === 'string' ? e.code : 'UNKNOWN';
  const responseCode = typeof e.responseCode === 'number' ? e.responseCode : null;
  const label = `SMTP ${code}${responseCode !== null ? ` (${responseCode})` : ''}`;
  const category = smtpCategory(code, responseCode);
  if (responseCode !== null) return { retriable: responseCode >= 400 && responseCode < 500, error: label, status: responseCode, category };
  return { retriable: TRANSIENT_CODES.has(code) || code === 'UNKNOWN', error: label, status: null, category };
}

function smtpCategory(code: string, responseCode: number | null): EmailErrorCategory {
  if (code === 'EAUTH' || code === 'ENOAUTH' || code === 'ETLS' || responseCode === 530 || responseCode === 535) return 'auth';
  if (responseCode === 421 || responseCode === 450 || responseCode === 451 || responseCode === 452) return 'unavailable';
  if (responseCode !== null && responseCode >= 500) return 'validation';
  if (TRANSIENT_CODES.has(code)) return 'network';
  return 'unknown';
}
