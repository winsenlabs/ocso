import type { EmailFetch, MailTransportFactory, OutgoingMail, SmtpTransportOptions } from '../src/index.js';

export const API_KEY = 're_test_9f8e7d6c5b4a3f2e1d0c';

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Headers;
  body: Record<string, unknown>;
  redirect: RequestInit['redirect'];
  signal: RequestInit['signal'];
}

/** Fake fetch that records requests; `respond` may return a Response or throw. */
export function fakeFetch(respond: () => Response | Promise<Response> = () => Response.json({ id: 'msg_1' })) {
  const calls: RecordedRequest[] = [];
  const fetch: EmailFetch = async (input, init) => {
    calls.push({
      url: input,
      method: init.method ?? 'GET',
      headers: new Headers(init.headers),
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
      redirect: init.redirect,
      signal: init.signal,
    });
    return respond();
  };
  return { fetch, calls };
}

export const resendError = (status: number, name: string, message: string): Response => Response.json({ statusCode: status, name, message }, { status });

export const thrown = (name: 'TimeoutError' | 'TypeError') => () => {
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

export const smtpError = (code: string, responseCode?: number) =>
  Object.assign(new Error(`${code} failed for user alerts@meridian.test with pass hunter2hunter2`), { code, responseCode });
