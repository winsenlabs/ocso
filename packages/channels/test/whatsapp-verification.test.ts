import { describe, expect, it } from 'vitest';
import { createWhatsAppAdapter } from '../src/index.js';
import { APP_SECRET, fixture, getRequest, postRequest, sign, VERIFY_TOKEN, waConfig } from './helpers/whatsapp.js';

const adapter = createWhatsAppAdapter({ fetch: () => Promise.reject(new Error('no network in tests')) });
const config = waConfig();

describe('WhatsApp POST signature verification', () => {
  const body = fixture('text');

  it('accepts a valid X-Hub-Signature-256 over the raw body', () => {
    expect(adapter.verifyRequest(postRequest(body), config)).toEqual({ kind: 'verified' });
  });

  it('accepts an upper-case hex signature', () => {
    const signature = `sha256=${sign(body).slice(7).toUpperCase()}`;
    expect(adapter.verifyRequest(postRequest(body, signature), config)).toEqual({ kind: 'verified' });
  });

  it('rejects a tampered body with the original signature', () => {
    const tampered = Buffer.from(body.toString('utf8').replace('charged twice', 'charged once'));
    expect(adapter.verifyRequest(postRequest(tampered, sign(body)), config)).toMatchObject({ kind: 'rejected', status: 403 });
  });

  it('rejects a re-serialized body (signature is over raw bytes, not parsed JSON)', () => {
    const reserialized = Buffer.from(JSON.stringify(JSON.parse(body.toString('utf8'))));
    expect(adapter.verifyRequest(postRequest(reserialized, sign(body)), config)).toMatchObject({ kind: 'rejected' });
  });

  it('rejects a signature made with the wrong app secret', () => {
    const result = adapter.verifyRequest(postRequest(body, sign(body, `${APP_SECRET}-wrong`)), config);
    expect(result).toMatchObject({ kind: 'rejected', status: 403 });
  });

  it('rejects a missing signature header with 401', () => {
    expect(adapter.verifyRequest(postRequest(body, null), config)).toMatchObject({ kind: 'rejected', status: 401 });
  });

  it.each(['sha1=abc', 'sha256=', 'sha256=zz', `sha256=${'a'.repeat(63)}`, 'deadbeef'])('rejects malformed header %s', (header) => {
    expect(adapter.verifyRequest(postRequest(body, header), config)).toMatchObject({ kind: 'rejected', status: 401 });
  });

  it('rejects when the channel has no app secret', () => {
    const result = adapter.verifyRequest(postRequest(body), waConfig({}, { appSecret: '' }));
    expect(result).toMatchObject({ kind: 'rejected', status: 403 });
  });

  it('rejects a signed request with no body', () => {
    expect(adapter.verifyRequest(postRequest(null, sign('')), config)).toMatchObject({ kind: 'rejected', status: 400 });
  });

  it('never echoes secrets in rejection reasons', () => {
    const result = adapter.verifyRequest(postRequest(body, sign(body, 'other')), config);
    expect(JSON.stringify(result)).not.toContain(APP_SECRET);
  });
});

describe('WhatsApp GET subscription challenge', () => {
  const query = (token: string, extra: Record<string, string> = {}) =>
    getRequest({ 'hub.mode': 'subscribe', 'hub.verify_token': token, 'hub.challenge': '1158201444', ...extra });

  it('echoes the challenge when the verify token matches', () => {
    expect(adapter.verifyRequest(query(VERIFY_TOKEN), config)).toEqual({ kind: 'challenge', status: 200, body: '1158201444' });
  });

  it('rejects a wrong verify token with 403', () => {
    expect(adapter.verifyRequest(query('not-the-token'), config)).toMatchObject({ kind: 'rejected', status: 403 });
  });

  it('rejects a verify token that is only a prefix of the real one', () => {
    expect(adapter.verifyRequest(query(VERIFY_TOKEN.slice(0, -1)), config)).toMatchObject({ kind: 'rejected', status: 403 });
  });

  it('rejects requests that are not subscribe handshakes', () => {
    expect(adapter.verifyRequest(query(VERIFY_TOKEN, { 'hub.mode': 'unsubscribe' }), config)).toMatchObject({ status: 400 });
    expect(adapter.verifyRequest(getRequest({ 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY_TOKEN }), config)).toMatchObject({
      status: 400,
    });
  });

  it('refuses to reflect a non-numeric-ish challenge (no reflected content)', () => {
    const result = adapter.verifyRequest(query(VERIFY_TOKEN, { 'hub.challenge': '<script>alert(1)</script>' }), config);
    expect(result).toMatchObject({ kind: 'rejected', status: 400 });
  });

  it('rejects when no verify token is configured', () => {
    expect(adapter.verifyRequest(query(''), waConfig({}, { verifyToken: '' }))).toMatchObject({ kind: 'rejected', status: 403 });
  });
});

describe('WhatsApp config validation', () => {
  it('accepts a complete config', () => {
    expect(adapter.validateConfig(config.settings, config.secrets)).toEqual([]);
  });

  it('reports missing settings and secrets without echoing secret values', () => {
    const problems = adapter.validateConfig({ graphApiVersion: '26', graphBaseUrl: 'http://graph.example.com' }, {
      accessToken: 'has space',
      verifyToken: 'short',
    });
    expect(problems.join('\n')).toMatch(/phoneNumberId/);
    expect(problems.join('\n')).toMatch(/graphApiVersion/);
    expect(problems.join('\n')).toMatch(/graphBaseUrl: must use https/);
    expect(problems.join('\n')).toMatch(/secrets.appSecret: required/);
    expect(problems.join('\n')).toMatch(/secrets.accessToken: must not contain whitespace/);
    expect(problems.join('\n')).toMatch(/secrets.verifyToken: must be at least 16/);
    expect(problems.join('\n')).not.toContain('has space');
  });

  it('allows an http graph base URL only for localhost', () => {
    expect(adapter.validateConfig({ phoneNumberId: '1', graphBaseUrl: 'http://localhost:4010' }, config.secrets)).toEqual([]);
  });
});
