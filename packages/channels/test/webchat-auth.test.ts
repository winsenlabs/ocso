import { describe, expect, it } from 'vitest';
import { createWebChatAdapter, issueVisitorToken, verifyHostJwt, verifyVisitorToken, WebChatAuthError } from '../src/index.js';
import { CHANNEL_ID, HOST_SECRET, hostJwt, NOW, unix, VISITOR_SECRET, wcConfig, widgetRequest } from './helpers/webchat.js';

let clock = NOW;
const adapter = createWebChatAdapter({ now: () => clock });
const config = wcConfig();

function authError(fn: () => unknown): WebChatAuthError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(WebChatAuthError);
    return error as WebChatAuthError;
  }
  throw new Error('expected an auth error');
}

describe('visitor tokens', () => {
  it('issues a channel-bound token that verifies back to the same visitor', () => {
    const issued = adapter.issueVisitorToken(config);
    expect(issued.token.startsWith('wcv1.')).toBe(true);
    expect(issued.visitorId).toMatch(/^v_[0-9a-f]{32}$/);
    expect(issued.expiresAt).toEqual(new Date(NOW.getTime() + 30 * 86_400_000));
    expect(verifyVisitorToken(issued.token, VISITOR_SECRET, { channelId: CHANNEL_ID, now: NOW })).toMatchObject({
      visitorId: issued.visitorId,
      channelId: CHANNEL_ID,
      externalCustomerRef: undefined,
    });
  });

  it('renews for an existing visitor and caps the TTL at the channel setting', () => {
    const issued = adapter.issueVisitorToken(wcConfig({ visitorTokenTtlSeconds: 3600 }), { visitorId: 'v_returning_visitor', ttlSeconds: 99_999 });
    expect(issued.visitorId).toBe('v_returning_visitor');
    expect(issued.expiresAt).toEqual(new Date(NOW.getTime() + 3_600_000));
  });

  it('rejects expired tokens (after clock-skew leeway) with 401', () => {
    const { token } = issueVisitorToken({ channelId: CHANNEL_ID, ttlSeconds: 600 }, VISITOR_SECRET, NOW);
    const later = new Date(NOW.getTime() + 600_000 + 30_000);
    expect(() => verifyVisitorToken(token, VISITOR_SECRET, { channelId: CHANNEL_ID, now: later })).not.toThrow();
    const error = authError(() => verifyVisitorToken(token, VISITOR_SECRET, { channelId: CHANNEL_ID, now: new Date(NOW.getTime() + 700_000) }));
    expect(error).toMatchObject({ reason: 'expired', status: 401, category: 'authentication' });
  });

  it('rejects tampered claims, a wrong secret and truncated tokens', () => {
    const { token } = issueVisitorToken({ channelId: CHANNEL_ID, ttlSeconds: 600 }, VISITOR_SECRET, NOW);
    const [prefix, claims, signature] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(claims ?? '', 'base64url').toString()), ref: 'cust_admin' })).toString('base64url');
    expect(authError(() => verifyVisitorToken(`${prefix}.${forged}.${signature}`, VISITOR_SECRET, { channelId: CHANNEL_ID, now: NOW })).reason).toBe('bad_signature');
    expect(authError(() => verifyVisitorToken(token, `${VISITOR_SECRET}x`, { channelId: CHANNEL_ID, now: NOW })).reason).toBe('bad_signature');
    expect(authError(() => verifyVisitorToken(`${prefix}.${claims}`, VISITOR_SECRET, { channelId: CHANNEL_ID, now: NOW })).reason).toBe('malformed');
    expect(authError(() => verifyVisitorToken(`${token}!`, VISITOR_SECRET, { channelId: CHANNEL_ID, now: NOW })).reason).toBe('bad_signature');
  });

  it('rejects a token issued for another channel', () => {
    const { token } = issueVisitorToken({ channelId: 'chn_other', ttlSeconds: 600 }, VISITOR_SECRET, NOW);
    expect(authError(() => verifyVisitorToken(token, VISITOR_SECRET, { channelId: CHANNEL_ID, now: NOW }))).toMatchObject({
      reason: 'wrong_channel',
      status: 403,
    });
  });

  it('refuses to issue tokens with invalid visitor ids or refs (typed validation errors)', () => {
    expect(() => adapter.issueVisitorToken(config, { visitorId: 'bad id!' })).toThrowError(expect.objectContaining({ code: 'invalid_visitor_id' }));
    expect(() => adapter.issueVisitorToken(config, { externalCustomerRef: '' })).toThrowError(expect.objectContaining({ code: 'invalid_customer_ref' }));
  });
});

describe('host-app JWTs', () => {
  const claims = { sub: 'cust_88213', name: 'Priya Raman', iat: unix(NOW), exp: unix(NOW, 900) };

  it('verifies HS256 tokens signed with the channel host secret', () => {
    expect(verifyHostJwt(hostJwt(claims), HOST_SECRET, { now: NOW })).toEqual({
      customerRef: 'cust_88213',
      name: 'Priya Raman',
      email: undefined,
      expiresAt: new Date((unix(NOW) + 900) * 1000),
      raw: claims,
    });
  });

  it('refuses alg=none, other algorithms and wrong secrets', () => {
    const unsigned = `${Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.`;
    expect(authError(() => verifyHostJwt(unsigned, HOST_SECRET, { now: NOW })).reason).toBe('malformed');
    const noneWithSig = hostJwt(claims, { alg: 'none' });
    expect(authError(() => verifyHostJwt(noneWithSig, HOST_SECRET, { now: NOW })).reason).toBe('unsupported_algorithm');
    expect(authError(() => verifyHostJwt(hostJwt(claims, { alg: 'RS256' }), HOST_SECRET, { now: NOW })).reason).toBe('unsupported_algorithm');
    expect(authError(() => verifyHostJwt(hostJwt(claims, { secret: 'wrong-secret' }), HOST_SECRET, { now: NOW })).reason).toBe('bad_signature');
  });

  it('enforces exp, nbf, iss and aud', () => {
    expect(authError(() => verifyHostJwt(hostJwt({ ...claims, exp: unix(NOW, -120) }), HOST_SECRET, { now: NOW })).reason).toBe('expired');
    expect(authError(() => verifyHostJwt(hostJwt({ ...claims, nbf: unix(NOW, 600) }), HOST_SECRET, { now: NOW })).reason).toBe('not_yet_valid');
    expect(authError(() => verifyHostJwt(hostJwt({ sub: 'x' }), HOST_SECRET, { now: NOW })).reason).toBe('malformed'); // exp required
    const scoped = { now: NOW, issuer: 'https://shop.example', audience: 'ocso-webchat' };
    expect(authError(() => verifyHostJwt(hostJwt({ ...claims, iss: 'https://evil.example', aud: 'ocso-webchat' }), HOST_SECRET, scoped)).reason).toBe('wrong_issuer');
    expect(authError(() => verifyHostJwt(hostJwt({ ...claims, iss: 'https://shop.example', aud: ['other'] }), HOST_SECRET, scoped)).reason).toBe('wrong_audience');
    expect(verifyHostJwt(hostJwt({ ...claims, iss: 'https://shop.example', aud: ['x', 'ocso-webchat'] }), HOST_SECRET, scoped).customerRef).toBe('cust_88213');
  });
});

describe('web chat verifyRequest and identity', () => {
  it('verifies visitor tokens and host JWTs from the Authorization header', () => {
    const visitor = adapter.issueVisitorToken(config);
    expect(adapter.verifyRequest(widgetRequest(visitor.token), config)).toEqual({ kind: 'verified' });
    expect(adapter.verifyRequest(widgetRequest(hostJwt({ sub: 'cust_1', exp: unix(NOW, 60) })), config)).toEqual({ kind: 'verified' });
  });

  it('401 for missing or expired tokens, 403 for forged ones', () => {
    expect(adapter.verifyRequest(widgetRequest(null), config)).toMatchObject({ kind: 'rejected', status: 401 });
    const short = issueVisitorToken({ channelId: CHANNEL_ID, ttlSeconds: 300 }, VISITOR_SECRET, NOW);
    clock = new Date(NOW.getTime() + 3_600_000);
    expect(adapter.verifyRequest(widgetRequest(short.token), config)).toMatchObject({ kind: 'rejected', status: 401 });
    clock = NOW;
    expect(adapter.verifyRequest(widgetRequest('wcv1.e30.AAAA'), config)).toMatchObject({ kind: 'rejected', status: 403 });
    expect(adapter.verifyRequest(widgetRequest('garbage'), config)).toMatchObject({ kind: 'rejected', status: 403 });
  });

  it('refuses host JWTs when the channel has no host secret', () => {
    const noHost = wcConfig({}, { hostJwtSecret: '' });
    expect(adapter.verifyRequest(widgetRequest(hostJwt({ sub: 'c', exp: unix(NOW, 60) })), noHost)).toMatchObject({ status: 403 });
  });

  it('rejects everything when the channel secrets are invalid', () => {
    const weak = wcConfig({}, { visitorTokenSecret: 'short' });
    expect(adapter.verifyRequest(widgetRequest('anything'), weak)).toMatchObject({ kind: 'rejected', status: 403 });
    expect(adapter.validateConfig({}, { visitorTokenSecret: 'short' })).toEqual(['secrets.visitorTokenSecret: must be at least 32 characters']);
  });

  it('maps identities: visitor, visitor with host-verified ref, and host JWT', () => {
    const anon = adapter.issueVisitorToken(config, { visitorId: 'v_anon_visitor' });
    expect(adapter.identify(widgetRequest(anon.token), config)).toMatchObject({
      identityKind: 'webchat_visitor',
      identityValue: 'v_anon_visitor',
      alternateIdentities: [],
    });
    const linked = adapter.issueVisitorToken(config, { visitorId: 'v_anon_visitor', externalCustomerRef: 'cust_88213' });
    expect(adapter.identify(widgetRequest(linked.token), config)).toMatchObject({
      identityKind: 'webchat_customer_ref',
      identityValue: `${CHANNEL_ID}:cust_88213`,
      alternateIdentities: [{ kind: 'webchat_visitor', value: 'v_anon_visitor' }],
    });
    expect(adapter.identify(widgetRequest(hostJwt({ sub: 'cust_42', name: 'Asha', exp: unix(NOW, 60) })), config)).toMatchObject({
      identityKind: 'webchat_customer_ref',
      identityValue: `${CHANNEL_ID}:cust_42`,
      profileName: 'Asha',
    });
  });
});
