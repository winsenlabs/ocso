import { classifySmtpError as classify } from '@ocso/email';

/** SMTP transport types and the nodemailer factory now live in @ocso/email (one SMTP stack for the deployment). */
export {
  nodemailerTransportFactory,
  type MailTransport,
  type MailTransportFactory,
  type OutgoingMail,
  type SmtpTransportOptions,
} from '@ocso/email';

/**
 * Classify an SMTP failure without echoing server text (which can include
 * account names). SMTP 4xx replies are transient by definition; 5xx are permanent.
 */
export function classifySmtpError(error: unknown): { retriable: boolean; error: string } {
  const c = classify(error);
  return { retriable: c.retriable, error: c.error };
}
