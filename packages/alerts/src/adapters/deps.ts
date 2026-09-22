import type { FetchFn } from '../http.js';
import type { MailTransportFactory } from './email-transport.js';

/** Everything an adapter needs from the outside world, injected for testability. */
export interface DeliveryAdapterDeps {
  fetch: FetchFn;
  /** SMTP transport factory (defaults to nodemailer in production wiring). */
  mailTransport: MailTransportFactory;
  /** Per-request timeout for HTTP and SMTP. Default 10 s. */
  timeoutMs?: number | undefined;
  now?: (() => Date) | undefined;
}
