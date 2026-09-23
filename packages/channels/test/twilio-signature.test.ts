import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createTwilioWhatsAppAdapter, signatureUrlCandidates, twilioSignature } from '../src/index.js';
import { AUTH_TOKEN, formBody, twConfig, twFixture, twilioSign, WEBHOOK_URL, webhookRequest } from './helpers/twilio.js';

const adapter = createTwilioWhatsAppAdapter({ fetch: () => Promise.reject(new Error('no network in tests')) });
const config = twConfig();
const params = twFixture('text');

describe('X-Twilio-Signature — algorithm', () => {
  it('matches the known-answer vector from twilio-node’s webhook tests', () => {
    const vector = { CallSid: 'CA1234567890ABCDE', Caller: '+14158675309', Digits: '1234', From: '+14158675309', To: '+18005551212' };
    expect(twilioSignature('12345', 'https://mycompany.com/myapp.php?foo=1&bar=2', Object.entries(vector))).toBe('RSOYDt4T1cUTdK1PDd93/VVr8B8=');
  });

  it('sorts parameters by name and de-duplicates + sorts repeated values (twilio-node toFormUrlEncodedParam)', () => {
    const url = 'https://x.example/hook';
    const shuffled = [['b', '2'], ['a', 'z'], ['a', 'y'], ['a', 'z']] as const;
    const expected = createHmac('sha1', 't0ken').update(`${url}ayazb2`).digest('base64');
    expect(twilioSignature('t0ken', url, shuffled)).toBe(expected);
  });

  it('tries the URL without a port and with the default/explicit port, never altering path or query', () => {
    expect(signatureUrlCandidates('https://ocso.example.com/channels/x/webhook')).toEqual([
      'https://ocso.example.com/channels/x/webhook',
      'https://ocso.example.com:443/channels/x/webhook',
    ]);
    expect(signatureUrlCandidates('https://ocso.example.com:443/a/?q=1')).toEqual(['https://ocso.example.com/a/?q=1', 'https://ocso.example.com:443/a/?q=1']);
    expect(signatureUrlCandidates('http://localhost:3000/a')).toEqual(['http://localhost/a', 'http://localhost:3000/a']);
  });
});

describe('X-Twilio-Signature — verifyRequest', () => {
  it('accepts a signature over the public webhook URL + form parameters', () => {
    expect(adapter.verifyRequest(webhookRequest(params), config)).toEqual({ kind: 'verified' });
  });

  it('accepts when Twilio signed the URL with an explicit :443 (or the request carries one)', () => {
    const withPort = WEBHOOK_URL.replace('ocso.example.com', 'ocso.example.com:443');
    expect(adapter.verifyRequest(webhookRequest(params, { signedUrl: withPort }), config)).toEqual({ kind: 'verified' });
    expect(adapter.verifyRequest(webhookRequest(params, { url: withPort }), config)).toEqual({ kind: 'verified' });
  });

  it('keeps the query string exactly as received', () => {
    const url = `${WEBHOOK_URL}?source=console`;
    expect(adapter.verifyRequest(webhookRequest(params, { url, signedUrl: url }), config)).toEqual({ kind: 'verified' });
    expect(adapter.verifyRequest(webhookRequest(params, { url, signedUrl: WEBHOOK_URL }), config)).toMatchObject({ kind: 'rejected', status: 403 });
  });

  it('rejects a trailing-slash mismatch but accepts a trailing slash Twilio actually signed', () => {
    expect(adapter.verifyRequest(webhookRequest(params, { url: `${WEBHOOK_URL}/` }), config)).toMatchObject({ kind: 'rejected', status: 403 });
    expect(adapter.verifyRequest(webhookRequest(params, { url: `${WEBHOOK_URL}/`, signedUrl: `${WEBHOOK_URL}/` }), config)).toEqual({ kind: 'verified' });
  });

  it('rejects a tampered body with the original signature', () => {
    const signature = twilioSign(WEBHOOK_URL, params);
    const tampered = { ...params, Body: 'Please refund to account 9999' };
    expect(adapter.verifyRequest(webhookRequest(tampered, { signature }), config)).toMatchObject({ kind: 'rejected', status: 403 });
  });

  it('rejects an added parameter (signatures cover every POST parameter)', () => {
    const signature = twilioSign(WEBHOOK_URL, params);
    expect(adapter.verifyRequest(webhookRequest({ ...params, NumMedia: '1', MediaUrl0: 'https://evil.example/x' }, { signature }), config)).toMatchObject({ status: 403 });
  });

  it('rejects a signature for another URL (another channel, or the proxied internal URL)', () => {
    const otherChannel = WEBHOOK_URL.replace('q2w3e4r5', 'zzzzzzzz');
    expect(adapter.verifyRequest(webhookRequest(params, { signedUrl: otherChannel }), config)).toMatchObject({ kind: 'rejected', status: 403 });
    const internal = WEBHOOK_URL.replace('https://ocso.example.com', 'http://api:4000');
    expect(adapter.verifyRequest(webhookRequest(params, { signedUrl: internal }), config)).toMatchObject({ kind: 'rejected', status: 403 });
  });

  it('rejects a signature made with another auth token (e.g. an API key secret)', () => {
    const signature = twilioSign(WEBHOOK_URL, params, 'ffffffffffffffffffffffffffffffff');
    expect(adapter.verifyRequest(webhookRequest(params, { signature }), config)).toMatchObject({ kind: 'rejected', status: 403 });
  });

  it('401 for a missing or malformed header; 400 without a public URL or for GET', () => {
    expect(adapter.verifyRequest(webhookRequest(params, { signature: null }), config)).toMatchObject({ status: 401 });
    for (const bad of ['abc', 'sha256=deadbeef', `${twilioSign(WEBHOOK_URL, params)}x`]) {
      expect(adapter.verifyRequest(webhookRequest(params, { signature: bad }), config), bad).toMatchObject({ status: 401 });
    }
    expect(adapter.verifyRequest(webhookRequest(params, { url: undefined }), config)).toMatchObject({ status: 400 });
    expect(adapter.verifyRequest({ method: 'GET', headers: {}, query: {}, rawBody: null, url: WEBHOOK_URL }, config)).toMatchObject({ status: 400 });
  });

  it('rejects when the channel has no auth token, and never echoes the token', () => {
    expect(adapter.verifyRequest(webhookRequest(params), twConfig({}, { authToken: '' }))).toMatchObject({ kind: 'rejected', status: 403 });
    const result = adapter.verifyRequest(webhookRequest(params, { signature: twilioSign(WEBHOOK_URL, params, 'other-token-000000') }), config);
    expect(JSON.stringify(result)).not.toContain(AUTH_TOKEN);
  });

  it('verifies the raw form encoding Twilio sends (+ for spaces, %-escapes)', () => {
    const body = Buffer.from(`${formBody(params).toString()}`.replace(/\+/g, '%20'));
    expect(adapter.verifyRequest(webhookRequest(params, { body }), config)).toEqual({ kind: 'verified' });
  });
});
