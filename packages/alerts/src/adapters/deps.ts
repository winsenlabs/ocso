import type { EmailSender } from '@ocso/email';
import type { FetchFn } from '../http.js';
import type { MailTransportFactory } from './email-transport.js';

/** Everything an adapter needs from the outside world, injected for testability. */
export interface DeliveryAdapterDeps {
  fetch: FetchFn;
  /** SMTP transport factory (defaults to nodemailer in production wiring). */
  mailTransport: MailTransportFactory;
  /** The deployment's own sender (EMAIL_DRIVER); EMAIL destinations with `transport: 'deployment'` use it. */
  emailSender?: EmailSender | null | undefined;
  /** Per-request timeout for HTTP and SMTP. Default 10 s. */
  timeoutMs?: number | undefined;
  now?: (() => Date) | undefined;
}
