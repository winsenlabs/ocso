import { describe, expect, it } from 'vitest';
import { EmailSendError, ResendEmailSender, classifyResendError, resendIdempotencyKey, resendTags, type EmailMessage } from '../src/index.js';
import { API_KEY, fakeFetch, resendError, thrown } from './helpers.js';

const FROM = 'Meridian Support <support@mail.meridian.test>';
const message = (overrides: Partial<EmailMessage> = {}): EmailMessage => ({
  to: 'tarun@meridian.test',
  subject: 'You are invited',
  html: '<p>Hi</p>',
  text: 'Hi',
  ...overrides,
});
const sender = (fetch: ReturnType<typeof fakeFetch>['fetch'], extra: Partial<ConstructorParameters<typeof ResendEmailSender>[0]> = {}) =>
  new ResendEmailSender({ apiKey: API_KEY, from: FROM, replyTo: 'help@meridian.test', fetch, baseUrl: 'https://resend.fake/', ...extra });

async function failure(respond: () => Response | Promise<Response>, msg = message()): Promise<EmailSendError> {
  const error = await sender(fakeFetch(respond).fetch).send(msg).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(EmailSendError);
  return error as EmailSendError;
}

describe('ResendEmailSender', () => {
  it('POSTs /emails with the bearer key, idempotency key, sanitized tags and reply-to', async () => {
    const f = fakeFetch();
    const result = await sender(f.fetch).send(
      message({ to: ['a@meridian.test', 'b@meridian.test'], subject: 'Line1\r\nBcc: evil@x.test', tags: { kind: 'invite', 'org name': 'Meridian Bank!' }, idempotencyKey: 'invite/42' }),
    );
    expect(result).toEqual({ id: 'msg_1' });
    const call = f.calls[0]!;
    expect(call.url).toBe('https://resend.fake/emails');
    expect(call.method).toBe('POST');
    expect(call.redirect).toBe('error');
    expect(call.signal).toBeInstanceOf(AbortSignal);
    expect(call.headers.get('authorization')).toBe(`Bearer ${API_KEY}`);
    expect(call.headers.get('idempotency-key')).toBe('invite/42');
    expect(call.headers.get('content-type')).toBe('application/json');
    expect(call.body).toEqual({
      from: FROM,
      to: ['a@meridian.test', 'b@meridian.test'],
      subject: 'Line1 Bcc: evil@x.test',
      html: '<p>Hi</p>',
      text: 'Hi',
      reply_to: 'help@meridian.test',
      tags: [
        { name: 'kind', value: 'invite' },
        { name: 'org_name', value: 'Meridian_Bank_' },
      ],
    });
  });

  it('omits optional fields: no idempotency header, no tags, message reply-to wins, no default reply-to', async () => {
    const f = fakeFetch();
    await sender(f.fetch).send(message({ replyTo: 'lead@meridian.test' }));
    await sender(f.fetch, { replyTo: null }).send(message());
    expect(f.calls[0]!.headers.has('idempotency-key')).toBe(false);
    expect(f.calls[0]!.body).not.toHaveProperty('tags');
    expect(f.calls[0]!.body['reply_to']).toBe('lead@meridian.test');
    expect(f.calls[1]!.body).not.toHaveProperty('reply_to');
    expect(f.calls[0]!.body['to']).toEqual(['tarun@meridian.test']);
  });

  it('sanitizes tags within Resend limits and hashes over-long idempotency keys', () => {
    const tags = resendTags({ 'kind': 'sign in', 'ünïcode': 'välue', '': 'dropped', empty: '', long: 'x'.repeat(300) });
    expect(tags).toEqual([
      { name: 'kind', value: 'sign_in' },
      { name: '_n_code', value: 'v_lue' },
      { name: 'empty', value: 'none' },
      { name: 'long', value: 'x'.repeat(256) },
    ]);
    const many = resendTags(Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`t${i}`, 'v'])));
    expect(many).toHaveLength(75);
    expect(resendIdempotencyKey('k'.repeat(256))).toBe('k'.repeat(256));
    const hashed = resendIdempotencyKey('k'.repeat(257));
    expect(hashed).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(resendIdempotencyKey('k'.repeat(257))).toBe(hashed);
  });

  it('rejects empty and >50 recipient lists before calling Resend', async () => {
    const f = fakeFetch();
    const tooMany = Array.from({ length: 51 }, (_, i) => `u${i}@meridian.test`);
    await expect(sender(f.fetch).send(message({ to: tooMany }))).rejects.toMatchObject({ retriable: false, category: 'validation' });
    await expect(sender(f.fetch).send(message({ to: [] }))).rejects.toMatchObject({ retriable: false });
    expect(f.calls).toHaveLength(0);
  });

  it('maps HTTP failures to retriable / permanent errors', async () => {
    const cases: Array<[number, string, boolean, string]> = [
      [400, 'validation_error', false, 'validation'],
      [400, 'invalid_idempotency_key', false, 'validation'],
      [401, 'missing_api_key', false, 'auth'],
      [403, 'validation_error', false, 'auth'],
      [404, 'not_found', false, 'unknown'],
      [409, 'concurrent_idempotent_requests', true, 'unavailable'],
      [409, 'invalid_idempotent_request', false, 'validation'],
      [422, 'missing_required_field', false, 'validation'],
      [429, 'rate_limit_exceeded', true, 'rate_limited'],
      [429, 'daily_quota_exceeded', true, 'rate_limited'],
      [500, 'application_error', true, 'unavailable'],
      [503, 'service_unavailable', true, 'unavailable'],
    ];
    for (const [status, name, retriable, category] of cases) {
      const error = await failure(() => resendError(status, name, 'Something went wrong.'));
      expect({ status: error.status, retriable: error.retriable, category: error.category }).toEqual({ status, retriable, category });
      expect(error.message).toContain(`Resend HTTP ${status} (${name}: Something went wrong.)`);
      expect(classifyResendError(status, name)).toEqual({ retriable, category });
    }
    // Non-JSON gateway pages still classify by status.
    expect(await failure(() => new Response('<html>bad gateway</html>', { status: 502 }))).toMatchObject({ retriable: true, status: 502, message: expect.not.stringContaining('html') });
  });

  it('treats timeouts and network errors as transient', async () => {
    expect(await failure(thrown('TimeoutError'))).toMatchObject({ retriable: true, category: 'network', status: null, message: 'Resend request timed out' });
    expect(await failure(thrown('TypeError'))).toMatchObject({ retriable: true, category: 'network', message: 'Resend request failed (network error)' });
  });

  it('never echoes the API key or recipient addresses in errors', async () => {
    const to = ['tarun.shetty@meridian.test', 'anjali.rao@meridian.test'];
    const echo = `API key ${API_KEY} cannot send to ${to[0]} or "${to[1]}" (also re_live_abcdef123456)`;
    const error = await failure(() => resendError(403, 'validation_error', echo), message({ to }));
    expect(error.message).not.toContain(API_KEY);
    expect(error.message).not.toContain('re_live_abcdef123456');
    expect(error.message).not.toContain('tarun.shetty');
    expect(error.message).not.toContain('anjali.rao');
    expect(error.message).toContain('2 recipients @meridian.test');
    expect(JSON.stringify(error)).not.toContain(API_KEY);
  });

  it('requires an API key and defaults to the public endpoint', async () => {
    expect(() => new ResendEmailSender({ apiKey: '', from: FROM })).toThrow(/API key/);
    const f = fakeFetch();
    await new ResendEmailSender({ apiKey: API_KEY, from: FROM, fetch: f.fetch }).send(message());
    expect(f.calls[0]!.url).toBe('https://api.resend.com/emails');
  });
});
