import type { AlertMessage, FetchFn, MailTransportFactory, OutgoingMail, SmtpTransportOptions } from '../src/index.js';

export interface RecordedCall {
  url: string;
  method: string;
  headers: Headers;
  rawBody: string;
  body: unknown;
  redirect: RequestInit['redirect'];
}

/** Fake fetch that records requests; `respond` may return a Response or throw. */
export function fakeFetch(respond: (url: string) => Response | Promise<Response> = () => new Response('ok', { status: 200 })) {
  const calls: RecordedCall[] = [];
  const fetch: FetchFn = async (input, init) => {
    const url = String(input);
    const rawBody = typeof init?.body === 'string' ? init.body : '';
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      rawBody,
      body: rawBody ? JSON.parse(rawBody) : undefined,
      redirect: init?.redirect,
    });
    return respond(url);
  };
  return { fetch, calls };
}

export const throwing = (name: 'TimeoutError' | 'TypeError') => () => {
  const error = new Error(name === 'TimeoutError' ? 'The operation was aborted due to timeout' : 'fetch failed');
  error.name = name;
  throw error;
};

export function fakeTransport(behaviour: (mail: OutgoingMail) => Promise<{ messageId?: string }> = async () => ({ messageId: '<m1@test>' })) {
  const sent: OutgoingMail[] = [];
  const options: SmtpTransportOptions[] = [];
  let closed = 0;
  const factory: MailTransportFactory = (o) => {
    options.push(o);
    return {
      async sendMail(mail) {
        sent.push(mail);
        return behaviour(mail);
      },
      close: () => {
        closed += 1;
      },
    };
  };
  return { factory, sent, options, closed: () => closed };
}

export const NOW = new Date('2026-09-22T10:00:00.000Z');

export function message(overrides: Partial<AlertMessage> = {}): AlertMessage {
  return {
    alertId: '0192f000-0000-7000-8000-000000000001',
    deliveryId: '0192f000-0000-7000-8000-00000000d001',
    event: 'OPENED',
    fingerprint: 'rule-1:0123456789abcdef0123456789abcdef',
    ruleId: 'rule-1',
    ruleName: 'Provider error rate above 5%',
    condition: 'provider_error_rate_above',
    kind: 'TECHNICAL',
    severity: 'CRITICAL',
    status: 'OPEN',
    title: 'Provider error rate above 5% · AWS Bedrock',
    body: '12 of 150 requests failed (8.0%) in the last 5m; threshold 5.0%.',
    value: '8.0%',
    source: 'Provider · AWS Bedrock',
    context: { providerId: 'p-1', errors: 12, total: 150 },
    occurrences: 1,
    openedAt: '2026-09-22T09:55:00.000Z',
    lastSeenAt: '2026-09-22T10:00:00.000Z',
    acknowledgedAt: null,
    resolvedAt: null,
    resolution: null,
    link: 'https://ocso.meridian.test/alerts/0192f000-0000-7000-8000-000000000001',
    deployment: 'Meridian Bank · PROD',
    ...overrides,
  };
}
