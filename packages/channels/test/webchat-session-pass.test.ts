import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { DomainError } from '@ocso/domain';
import {
  contextFromClaims,
  createWebChatAdapter,
  filterContext,
  mintSessionPass,
  openUserToken,
  sealUserToken,
  verifySessionPass,
  WebChatAuthError,
  type ChannelFetch,
  type EmbeddedChat,
  type EmbedSessionHooks,
} from '../src/index.js';
import { CHANNEL_ID, hostJwt, NOW, unix, wcConfig } from './helpers/webchat.js';

const SECRET_KEY = `sk_${'k'.repeat(43)}`;
const JWKS_URL = 'https://id.example.com/.well-known/jwks.json';
const ISSUER = 'https://id.example.com';

/** Single-use store standing in for the API's session-pass table. */
function passHooks(): EmbedSessionHooks & { used: Set<string> } {
  const used = new Set<string>();
  return { used, consumeOnce: async (id) => (used.has(id) ? false : (used.add(id), true)) };
}

async function rejection(p: Promise<unknown>): Promise<DomainError> {
  try {
    await p;
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error('expected a rejection');
}

let privateKey: CryptoKey;
let jwks: { keys: unknown[] };
let fetches = 0;
const jwksFetch: ChannelFetch = async (input) => {
  fetches++;
  expect(String(input)).toBe(JWKS_URL);
  return new Response(JSON.stringify(jwks), { status: 200, headers: { 'content-type': 'application/json' } });
};

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' }] };
});

const idToken = (claims: Record<string, unknown>, options: { exp?: number; aud?: string; kid?: string } = {}) =>
  new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: options.kid ?? 'k1' })
    .setIssuer(ISSUER)
    .setAudience(options.aud ?? 'ocso-chat')
    .setIssuedAt(unix(NOW))
    .setExpirationTime(options.exp ?? unix(NOW, 900))
    .sign(privateKey);

function embed(fetch: ChannelFetch = jwksFetch, now = NOW): EmbeddedChat {
  return createWebChatAdapter({ now: () => now, fetch }).embed;
}

const jwksAuth = (mode: string, extra: Record<string, unknown> = {}) => ({
  auth: { mode, userToken: { verify: 'jwks', jwksUrl: JWKS_URL, issuer: ISSUER, audience: 'ocso-chat' } },
  context: { allow: ['plan', 'orderId', 'email'] },
  ...extra,
});

describe('session passes (wsp1)', () => {
  it('mints and verifies a channel-bound pass keyed off the secret key (HKDF), never containing the key', () => {
    const { pass, claims, expiresAt } = mintSessionPass({ channelId: CHANNEL_ID, ttlSeconds: 600, sub: 'cust-1', context: { plan: 'gold' }, userVerified: true }, SECRET_KEY, NOW);
    expect(pass.startsWith('wsp1.')).toBe(true);
    expect(pass).not.toContain(SECRET_KEY);
    expect(expiresAt).toEqual(new Date((unix(NOW) + 600) * 1000));
    expect(verifySessionPass(pass, SECRET_KEY, { channelId: CHANNEL_ID, now: NOW })).toEqual(claims);
    expect(claims).toMatchObject({ ch: CHANNEL_ID, sub: 'cust-1', ctx: { plan: 'gold' }, ut: 1 });
  });

  it('refuses tampered, foreign, expired and other-key passes', () => {
    const { pass } = mintSessionPass({ channelId: CHANNEL_ID, ttlSeconds: 60, userVerified: false }, SECRET_KEY, NOW);
    const [p, body, sig] = pass.split('.');
    const forged = `${p}.${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body!, 'base64url').toString()), sub: 'admin' })).toString('base64url')}.${sig}`;
    const code = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        return (e as DomainError).code;
      }
      return 'ok';
    };
    expect(code(() => verifySessionPass(forged, SECRET_KEY, { channelId: CHANNEL_ID, now: NOW }))).toBe('session_pass_invalid');
    expect(code(() => verifySessionPass(pass, `sk_${'x'.repeat(43)}`, { channelId: CHANNEL_ID, now: NOW }))).toBe('session_pass_invalid');
    expect(code(() => verifySessionPass(pass, SECRET_KEY, { channelId: 'other', now: NOW }))).toBe('session_pass_invalid');
    expect(code(() => verifySessionPass(pass, SECRET_KEY, { channelId: CHANNEL_ID, now: new Date(NOW.getTime() + 61_000) }))).toBe('session_pass_expired');
    expect(code(() => verifySessionPass('wsp1.x', SECRET_KEY, { channelId: CHANNEL_ID, now: NOW }))).toBe('session_pass_invalid');
  });

  it('clamps the lifetime to 60..3600 seconds', () => {
    expect(mintSessionPass({ channelId: CHANNEL_ID, ttlSeconds: 5, userVerified: false }, SECRET_KEY, NOW).claims.exp - unix(NOW)).toBe(60);
    expect(mintSessionPass({ channelId: CHANNEL_ID, ttlSeconds: 99_999, userVerified: false }, SECRET_KEY, NOW).claims.exp - unix(NOW)).toBe(3_600);
  });
});

describe('site context', () => {
  const settings = { allow: ['plan', 'orderId'], maxBytes: 64 };
  it('keeps allowlisted scalar keys and enforces maxBytes', () => {
    expect(filterContext({ plan: 'gold', orderId: 42, secret: 'x' }, settings)).toEqual({ plan: 'gold', orderId: 42 });
    expect(filterContext(undefined, settings)).toEqual({});
    expect(() => filterContext({ plan: { nested: true } }, settings)).toThrow(/string, number or boolean/);
    expect(() => filterContext({ plan: 'g'.repeat(80) }, settings)).toThrow(/exceeds 64 bytes/);
  });
  it('picks allowlisted scalar claims from a verified token', () => {
    expect(contextFromClaims({ plan: 'gold', orderId: ['x'], iss: 'y' }, settings)).toEqual({ plan: 'gold' });
  });
});

describe('held user tokens (AES-256-GCM)', () => {
  it('opens only with the same secret key and refuses tampering', () => {
    const sealed = sealUserToken('eyJ.user.token', SECRET_KEY);
    expect(sealed).not.toContain('eyJ.user.token');
    expect(openUserToken(sealed, SECRET_KEY)).toBe('eyJ.user.token');
    expect(openUserToken(sealed, `sk_${'z'.repeat(43)}`)).toBeNull();
    const parts = sealed.split('.');
    expect(openUserToken([...parts.slice(0, 3), Buffer.from('tampered').toString('base64url')].join('.'), SECRET_KEY)).toBeNull();
  });
});

describe('embed: auth modes', () => {
  it('anonymous: works as before; browser context is kept as unverified', async () => {
    const e = embed();
    const config = wcConfig({ context: { allow: ['plan'] } });
    const session = await e.openSession(config, { context: { plan: 'free', other: 'dropped' } }, passHooks());
    expect(session.authenticated).toBe(false);
    expect(session.visitor).toMatchObject({ identityKind: 'webchat_visitor', context: { source: 'client', values: { plan: 'free' } } });
    const renewed = await e.openSession(config, { visitorToken: session.token }, passHooks());
    expect(renewed.visitorId).toBe(session.visitorId);
    expect((await e.identify(config, renewed.token)).context?.values).toEqual({ plan: 'free' });
  });

  it('client: a session pass is required, single use, and its context is trusted', async () => {
    const e = embed();
    const config = wcConfig({ auth: { mode: 'client' }, context: { allow: ['plan'] } }, { secretKey: SECRET_KEY });
    const hooks = passHooks();
    expect((await rejection(e.openSession(config, {}, hooks))).code).toBe('session_pass_required');
    const minted = await e.mintSessionPass!(config, { secretKey: SECRET_KEY, context: { plan: 'gold', nope: 1 }, visitorId: 'v_device_0001' });
    const session = await e.openSession(config, { sessionPass: minted.sessionPass, context: { plan: 'hacked' } }, hooks);
    expect(session.visitorId).toBe('v_device_0001');
    expect(session.visitor.context).toMatchObject({ source: 'host', values: { plan: 'gold' } });
    expect((await rejection(e.openSession(config, { sessionPass: minted.sessionPass }, hooks))).code).toBe('session_pass_used');
    // Visitor tokens from anonymous days are refused in client mode.
    const anonymous = await embed().openSession(wcConfig(), {}, passHooks());
    const refused = await rejection(e.identify(config, anonymous.token));
    expect(refused).toBeInstanceOf(WebChatAuthError);
    expect(refused.code).toBe('webchat_token_session_pass_required');
    expect((await e.identify(config, session.token)).identityValue).toBe('v_device_0001');
  });

  it('checks the secret key in constant time and refuses a missing one', async () => {
    const e = embed();
    const config = wcConfig({ auth: { mode: 'client' } }, { secretKey: SECRET_KEY });
    expect((await rejection(e.mintSessionPass!(config, { secretKey: 'sk_wrong' }))).code).toBe('secret_key_invalid');
    expect((await rejection(e.mintSessionPass!(config, { secretKey: undefined }))).code).toBe('secret_key_invalid');
    expect((await rejection(e.mintSessionPass!(wcConfig(), { secretKey: SECRET_KEY }))).code).toBe('secret_key_invalid');
  });

  it('user (JWKS): a verified user token directly or through a pass; the ref becomes the customer', async () => {
    fetches = 0;
    const e = embed();
    const config = wcConfig(jwksAuth('user'), { secretKey: SECRET_KEY });
    expect((await rejection(e.openSession(config, {}, passHooks()))).code).toBe('user_token_required');
    const token = await idToken({ sub: 'cust-42', name: 'Asha', email: 'asha@example.com', plan: 'gold' });
    const direct = await e.openSession(config, { userToken: token }, passHooks());
    expect(direct.authenticated).toBe(true);
    expect(direct.visitor).toMatchObject({ identityKind: 'webchat_customer_ref', identityValue: `${CHANNEL_ID}:cust-42`, verified: true, profileName: 'Asha' });
    expect(direct.visitor.context).toMatchObject({ source: 'host', values: { plan: 'gold', email: 'asha@example.com' } });
    expect(direct.userToken).toBeUndefined(); // tool identity ocso: nothing held
    // A pass without a verified user is refused in user mode (both when minting and when exchanging).
    expect((await rejection(e.mintSessionPass!(config, { secretKey: SECRET_KEY }))).code).toBe('user_token_required');
    const pass = await e.mintSessionPass!(config, { secretKey: SECRET_KEY, userToken: token });
    const viaPass = await e.openSession(config, { sessionPass: pass.sessionPass }, passHooks());
    expect(viaPass.visitor).toMatchObject({ identityValue: `${CHANNEL_ID}:cust-42`, verified: true });
    expect(fetches).toBe(1); // the key set is cached
  });

  it('user (JWKS): refuses wrong audience, expired, unknown key and unreachable key sets', async () => {
    const e = embed();
    const config = wcConfig(jwksAuth('user'));
    expect((await rejection(e.openSession(config, { userToken: await idToken({ sub: 'c' }, { aud: 'other' }) }, passHooks()))).code).toBe('user_token_invalid');
    expect((await rejection(e.openSession(config, { userToken: await idToken({ sub: 'c' }, { exp: unix(NOW, -600) }) }, passHooks()))).code).toBe('user_token_invalid');
    expect((await rejection(e.openSession(config, { userToken: hostJwt({ sub: 'c', exp: unix(NOW, 60) }) }, passHooks()))).code).toBe('user_token_invalid');
    const down = embed(async () => {
      throw new TypeError('fetch failed');
    });
    const unavailable = await rejection(down.openSession(config, { userToken: await idToken({ sub: 'c' }) }, passHooks()));
    expect(unavailable).toMatchObject({ code: 'user_token_keys_unavailable', category: 'provider_unavailable' });
  });

  it('user (HS256): the host identity secret verifies user tokens; legacy hostToken still works', async () => {
    const e = embed();
    const config = wcConfig({ auth: { mode: 'user', userToken: { verify: 'hs256', issuer: 'shop' } } });
    const good = hostJwt({ sub: 'cust-7', iss: 'shop', exp: unix(NOW, 300) });
    expect((await e.openSession(config, { hostToken: good }, passHooks())).visitor.identityValue).toBe(`${CHANNEL_ID}:cust-7`);
    expect((await rejection(e.openSession(config, { userToken: hostJwt({ sub: 'x', iss: 'evil', exp: unix(NOW, 300) }) }, passHooks()))).code).toBe('user_token_invalid');
    // In user mode a plain visitor token (no verified user) is refused as a bearer.
    const anonymous = await embed().openSession(wcConfig(), {}, passHooks());
    expect((await rejection(e.identify(config, anonymous.token))).code).toBe('webchat_token_user_required');
  });

  it('passthrough: a verified user token is sealed for tool calls and expires with the token (at most 24 h)', async () => {
    const e = embed();
    const config = wcConfig(jwksAuth('user', { toolIdentity: 'passthrough' }), { secretKey: SECRET_KEY });
    const token = await idToken({ sub: 'cust-9' }, { exp: unix(NOW, 1_800) });
    const session = await e.openSession(config, { userToken: token }, passHooks());
    expect(session.userToken?.expiresAt).toEqual(new Date((unix(NOW) + 1_800) * 1000));
    expect(e.openUserToken!(config, session.userToken!.sealed)).toBe(token);
    const pass = await e.mintSessionPass!(config, { secretKey: SECRET_KEY, userToken: token, visitorId: 'v_device_0002' });
    expect(pass.userToken?.visitor).toMatchObject({ identityKind: 'webchat_customer_ref', identityValue: `${CHANNEL_ID}:cust-9`, alternateIdentities: [{ kind: 'webchat_visitor', value: 'v_device_0002' }] });
    expect(pass.sessionPass).not.toContain(token.split('.')[1]!);
    // Switching tool identity back to ocso (same secret key) stops held tokens from being opened at once.
    const ocso = wcConfig(jwksAuth('user'), { secretKey: SECRET_KEY });
    expect(e.openUserToken!(ocso, session.userToken!.sealed)).toBeNull();
  });

  it('client: a raw host-signed HS256 token is not a bearer (it must be exchanged with a session pass)', async () => {
    const e = embed();
    const config = wcConfig({ auth: { mode: 'client', userToken: { verify: 'hs256' } } }, { secretKey: SECRET_KEY });
    const raw = hostJwt({ sub: 'cust-8', exp: unix(NOW, 300) });
    expect((await rejection(e.identify(config, raw))).code).toBe('webchat_token_session_pass_required');
    // The same token is still accepted in user mode (a verified user) and in anonymous mode.
    expect((await e.identify(wcConfig({ auth: { mode: 'user', userToken: { verify: 'hs256' } } }), raw)).identityValue).toBe(`${CHANNEL_ID}:cust-8`);
    expect((await e.identify(wcConfig(), raw)).identityValue).toBe(`${CHANNEL_ID}:cust-8`);
  });

  it('a shared browser: the visitor id carries over only while the verified user stays the same', async () => {
    const e = embed();
    const hs = wcConfig({ auth: { mode: 'anonymous', userToken: { verify: 'hs256' } } });
    const guest = await e.openSession(hs, {}, passHooks());
    // A guest who signs in keeps their visitor (their conversation follows them).
    const alice = await e.openSession(hs, { visitorToken: guest.token, userToken: hostJwt({ sub: 'alice', exp: unix(NOW, 300) }) }, passHooks());
    expect(alice.visitorId).toBe(guest.visitorId);
    expect(alice.visitor.alternateIdentities).toEqual([{ kind: 'webchat_visitor', value: guest.visitorId }]);
    const again = await e.openSession(hs, { visitorToken: alice.token, userToken: hostJwt({ sub: 'alice', exp: unix(NOW, 300) }) }, passHooks());
    expect(again.visitorId).toBe(guest.visitorId);
    // Bob on the same browser (Alice never signed out): a new visitor, nothing of Alice's is linked.
    const bob = await e.openSession(hs, { visitorToken: again.token, userToken: hostJwt({ sub: 'bob', exp: unix(NOW, 300) }) }, passHooks());
    expect(bob.visitorId).not.toBe(guest.visitorId);
    expect(bob.visitor).toMatchObject({ identityValue: `${CHANNEL_ID}:bob`, alternateIdentities: [{ kind: 'webchat_visitor', value: bob.visitorId }] });

    // Session passes: a pass for another user, or for no user after one, starts a new visitor too.
    const client = wcConfig({ auth: { mode: 'client', userToken: { verify: 'jwks', jwksUrl: JWKS_URL, issuer: ISSUER, audience: 'ocso-chat' } } }, { secretKey: SECRET_KEY });
    const passFor = async (sub?: string, visitorId?: string) =>
      (await e.mintSessionPass!(client, { secretKey: SECRET_KEY, visitorId, ...(sub ? { userToken: await idToken({ sub }) } : {}) })).sessionPass;
    const a1 = await e.openSession(client, { sessionPass: await passFor('alice') }, passHooks());
    const a2 = await e.openSession(client, { visitorToken: a1.token, sessionPass: await passFor('alice') }, passHooks());
    expect(a2.visitorId).toBe(a1.visitorId);
    const b1 = await e.openSession(client, { visitorToken: a2.token, sessionPass: await passFor('bob') }, passHooks());
    expect(b1.visitorId).not.toBe(a1.visitorId);
    const anon = await e.openSession(client, { visitorToken: b1.token, sessionPass: await passFor() }, passHooks());
    expect([a1.visitorId, b1.visitorId]).not.toContain(anon.visitorId);
    expect(anon.visitor).toMatchObject({ identityKind: 'webchat_visitor', alternateIdentities: [] });
    // An anonymous visitor who then signs in keeps the visitor; a visitor id the backend pinned is kept for its user.
    const signedIn = await e.openSession(client, { visitorToken: anon.token, sessionPass: await passFor('carol') }, passHooks());
    expect(signedIn.visitorId).toBe(anon.visitorId);
    const pinned = await e.openSession(client, { visitorToken: signedIn.token, sessionPass: await passFor('dave', 'v_backend_pinned') }, passHooks());
    expect(pinned.visitorId).toBe('v_backend_pinned');
    // A user token for someone else than the pass's user drops the pinned id.
    const hsClient = wcConfig({ auth: { mode: 'client', userToken: { verify: 'hs256' } } }, { secretKey: SECRET_KEY });
    const pinnedPass = (await e.mintSessionPass!(hsClient, { secretKey: SECRET_KEY, userToken: hostJwt({ sub: 'erin', exp: unix(NOW, 300) }), visitorId: 'v_backend_erin' })).sessionPass;
    const other = await e.openSession(hsClient, { sessionPass: pinnedPass, userToken: hostJwt({ sub: 'frank', exp: unix(NOW, 300) }) }, passHooks());
    expect(other.visitorId).not.toBe('v_backend_erin');
  });

  it('verified user ids are scoped to the channel that verified them', async () => {
    const e = embed();
    const token = hostJwt({ sub: 'user-42', exp: unix(NOW, 300) });
    const a = wcConfig({ auth: { mode: 'user', userToken: { verify: 'hs256' } } });
    const b = { ...a, id: 'chn_other_site' };
    expect((await e.identify(a, token)).identityValue).toBe(`${CHANNEL_ID}:user-42`);
    expect((await e.identify(b, token)).identityValue).toBe('chn_other_site:user-42');
  });

  it('widget config reports the access rules', () => {
    const e = embed();
    expect(e.widgetConfig(wcConfig({ auth: { mode: 'client', allowNativeApps: true } }, { secretKey: SECRET_KEY }))).toMatchObject({ authMode: 'client', allowNativeApps: true });
    expect(e.widgetConfig(wcConfig())).toMatchObject({ authMode: 'anonymous', allowNativeApps: false });
  });
});

describe('settings validation for the access rules', () => {
  const adapter = createWebChatAdapter();
  const base = { visitorTokenSecret: 'v'.repeat(40) };
  it('needs a secret key for client mode and passthrough, and a way to verify users for user mode', () => {
    expect(adapter.validateConfig({ auth: { mode: 'client' } }, base)).toContain('secrets.secretKey: required when the auth mode is client');
    expect(adapter.validateConfig({ auth: { mode: 'user' } }, base)).toContain('settings.auth.userToken: signed-in users need a JWKS URL or the host identity secret (HS256)');
    expect(adapter.validateConfig({ auth: { mode: 'user', userToken: { verify: 'hs256' } } }, base)).toContain('secrets.hostJwtSecret: required to verify user tokens with HS256');
    expect(adapter.validateConfig({ toolIdentity: 'passthrough', ...jwksAuth('user') }, base)).toContain('secrets.secretKey: required to keep user tokens for passthrough');
    expect(adapter.validateConfig({ auth: { mode: 'user', userToken: { verify: 'jwks', jwksUrl: 'http://id.example.com/jwks', issuer: 'i', audience: 'a' } } }, base)).toContain(
      'settings.auth.userToken.jwksUrl: must be an https URL',
    );
    expect(adapter.validateConfig({}, { ...base, secretKey: 'not-a-key' })).toContain('secrets.secretKey: must be sk_ followed by at least 32 url-safe characters');
    expect(adapter.validateConfig({ ...jwksAuth('user'), toolIdentity: 'passthrough' }, { ...base, secretKey: SECRET_KEY })).toEqual([]);
    expect(adapter.validateConfig({ context: { allow: ['9bad'] } }, base)[0]).toMatch(/^settings\.context\.allow\.0:/);
  });
});
