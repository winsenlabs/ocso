import { describe, expect, it } from 'vitest';
import { BotFrameworkKeyStore, createMsTeamsAdapter, KEYS_TTL_MS, REFRESH_COOLDOWN_MS, SigningKeysUnavailableError } from '../src/index.js';
import { activity, APP_ID, connectorToken, json, JWKS_URL, METADATA_URL, microsoftFetch, mtConfig, NOW, SERVICE_URL, signingKey, teamsRequest } from './helpers/teams.js';

async function setup(options: Parameters<typeof microsoftFetch>[0] = {}, now = () => NOW) {
  const key = await signingKey();
  const ms = microsoftFetch({ keys: [key.jwk], ...options });
  const adapter = createMsTeamsAdapter({ fetch: ms.fetch, now });
  return { key, ms, adapter };
}

describe('Teams verification — Bot Connector JWT', () => {
  it('accepts a token signed by a published key, for this app, from the Bot Framework issuer, bound to the activity’s serviceUrl', async () => {
    const { key, adapter, ms } = await setup();
    const result = await adapter.verifyRequest(teamsRequest(activity(), await connectorToken(key)), mtConfig());
    expect(result).toEqual({ kind: 'verified' });
    expect(ms.calls.map((c) => [c.url, c.redirect])).toEqual([
      [METADATA_URL, 'error'],
      [JWKS_URL, 'error'],
    ]);
  });

  it('rejects a missing or malformed Authorization header with 401', async () => {
    const { adapter } = await setup();
    expect(await adapter.verifyRequest(teamsRequest(activity(), null), mtConfig())).toMatchObject({ kind: 'rejected', status: 401 });
    const bad = { ...teamsRequest(activity(), null), headers: { authorization: 'Basic abc' } };
    expect(await adapter.verifyRequest(bad, mtConfig())).toMatchObject({ kind: 'rejected', status: 401 });
  });

  it('rejects an expired token with 401 (beyond the 5-minute skew) and accepts one inside it', async () => {
    const { key, adapter } = await setup();
    const t = Math.floor(NOW.getTime() / 1000);
    expect(await adapter.verifyRequest(teamsRequest(activity(), await connectorToken(key, { iat: t - 7200, exp: t - 301 })), mtConfig())).toMatchObject({ kind: 'rejected', status: 401, reason: 'token expired' });
    expect(await adapter.verifyRequest(teamsRequest(activity(), await connectorToken(key, { iat: t - 3600, exp: t - 60 })), mtConfig())).toEqual({ kind: 'verified' });
  });

  it('rejects another bot’s audience and a foreign issuer with 403', async () => {
    const { key, adapter } = await setup();
    const other = await adapter.verifyRequest(teamsRequest(activity(), await connectorToken(key, { aud: '00000000-0000-4000-8000-000000000000' })), mtConfig());
    expect(other).toMatchObject({ kind: 'rejected', status: 403, reason: expect.stringContaining('aud') });
    const iss = await adapter.verifyRequest(teamsRequest(activity(), await connectorToken(key, { iss: 'https://sts.windows.net/evil/' })), mtConfig());
    expect(iss).toMatchObject({ kind: 'rejected', status: 403, reason: expect.stringContaining('iss') });
  });

  it('rejects a tampered signature, an unknown key and a key not endorsed for msteams', async () => {
    const { key, adapter } = await setup();
    const token = await connectorToken(key);
    const [h, p, s] = token.split('.') as [string, string, string];
    const tampered = `${h}.${p}.${s.slice(0, -4)}${s.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA'}`;
    expect(await adapter.verifyRequest(teamsRequest(activity(), tampered), mtConfig())).toMatchObject({ kind: 'rejected', status: 403 });
    const stranger = await signingKey('not-published');
    expect(await adapter.verifyRequest(teamsRequest(activity(), await connectorToken(stranger)), mtConfig())).toMatchObject({ kind: 'rejected', status: 403, reason: 'token signed by an unknown key' });
    // A key Microsoft endorses only for another channel (e.g. the Web Chat test) cannot sign a msteams activity.
    const webchat = await signingKey('webchat-only', ['webchat']);
    const endorsed = await setup({ keys: [webchat.jwk] });
    expect(await endorsed.adapter.verifyRequest(teamsRequest(activity(), await connectorToken(webchat)), mtConfig())).toMatchObject({ kind: 'rejected', status: 403 });
  });

  it('rejects a body that was changed after signing: the serviceUrl must equal the token’s claim', async () => {
    const { key, adapter } = await setup();
    const token = await connectorToken(key);
    const moved = activity({ serviceUrl: 'https://smba.trafficmanager.net/emea/' });
    expect(await adapter.verifyRequest(teamsRequest(moved, token), mtConfig())).toMatchObject({ kind: 'rejected', status: 403, reason: 'serviceUrl does not match the token' });
    expect(await adapter.verifyRequest(teamsRequest(activity(), await connectorToken(key, { serviceUrl: null })), mtConfig())).toMatchObject({ kind: 'rejected', status: 403 });
    // Trailing slash and case differences are the same URL.
    expect(await adapter.verifyRequest(teamsRequest(activity({ serviceUrl: SERVICE_URL.toUpperCase().replace('HTTPS', 'https') }), token), mtConfig())).toEqual({ kind: 'verified' });
  });

  it('refuses a validly signed activity whose serviceUrl is not a Bot Connector host (SSRF guard)', async () => {
    const { key, adapter } = await setup();
    const evil = 'https://attacker.example.com/';
    const result = await adapter.verifyRequest(teamsRequest(activity({ serviceUrl: evil }), await connectorToken(key, { serviceUrl: evil })), mtConfig());
    expect(result).toMatchObject({ kind: 'rejected', status: 403, reason: 'serviceUrl is not a Bot Connector endpoint' });
  });

  it('rejects non-RS256 tokens, GETs, non-activity bodies and an unconfigured channel', async () => {
    const { key, adapter } = await setup();
    const token = await connectorToken(key);
    const [, p, s] = token.split('.') as [string, string, string];
    const none = `${Buffer.from(JSON.stringify({ alg: 'none', kid: key.kid })).toString('base64url')}.${p}.${s}`;
    expect(await adapter.verifyRequest(teamsRequest(activity(), none), mtConfig())).toMatchObject({ kind: 'rejected', status: 403 });
    expect(await adapter.verifyRequest(teamsRequest(activity(), token, 'GET'), mtConfig())).toMatchObject({ kind: 'rejected', status: 400 });
    expect(await adapter.verifyRequest(teamsRequest('not json', token), mtConfig())).toMatchObject({ kind: 'rejected', status: 400 });
    expect(await adapter.verifyRequest(teamsRequest(activity(), token), mtConfig({ appId: 'nope' }))).toMatchObject({ kind: 'rejected', status: 403 });
  });

  it('throws SigningKeysUnavailableError (502, the Bot Connector retries) when Microsoft’s keys cannot be fetched', async () => {
    const { key, adapter } = await setup({ metadata: () => json({ error: 'down' }, 503) });
    await expect(adapter.verifyRequest(teamsRequest(activity(), await connectorToken(key)), mtConfig())).rejects.toBeInstanceOf(SigningKeysUnavailableError);
  });
});

describe('Bot Framework signing key cache', () => {
  it('caches keys for the TTL, then refetches', async () => {
    const key = await signingKey();
    const ms = microsoftFetch({ keys: [key.jwk] });
    let now = NOW.getTime();
    const store = new BotFrameworkKeyStore(ms.fetch, () => now);
    expect(await store.key(METADATA_URL, key.kid)).not.toBeNull();
    expect(await store.key(METADATA_URL, key.kid)).not.toBeNull();
    expect(ms.calls).toHaveLength(2);
    now += KEYS_TTL_MS;
    await store.key(METADATA_URL, key.kid);
    expect(ms.calls).toHaveLength(4);
  });

  it('refreshes for an unknown kid at most once per cooldown (forged kids cannot hammer Microsoft)', async () => {
    const key = await signingKey();
    const ms = microsoftFetch({ keys: [key.jwk] });
    let now = NOW.getTime();
    const store = new BotFrameworkKeyStore(ms.fetch, () => now);
    await store.key(METADATA_URL, key.kid);
    now += 1_000;
    expect(await store.key(METADATA_URL, 'forged-1')).toBeNull();
    expect(await store.key(METADATA_URL, 'forged-2')).toBeNull();
    expect(ms.calls).toHaveLength(2);
    now += REFRESH_COOLDOWN_MS;
    expect(await store.key(METADATA_URL, 'rolled-key')).toBeNull();
    expect(ms.calls).toHaveLength(4);
  });

  it('shares one fetch between concurrent misses', async () => {
    const key = await signingKey();
    const ms = microsoftFetch({ keys: [key.jwk] });
    const store = new BotFrameworkKeyStore(ms.fetch, () => NOW.getTime());
    await Promise.all([store.key(METADATA_URL, key.kid), store.key(METADATA_URL, key.kid), store.key(METADATA_URL, key.kid)]);
    expect(ms.calls).toHaveLength(2);
  });

  it('refuses an http jwks_uri from an https metadata document and a key set with no usable RSA key', async () => {
    const http = microsoftFetch({ metadata: () => json({ jwks_uri: 'http://login.botframework.com/keys' }) });
    await expect(new BotFrameworkKeyStore(http.fetch, () => 0).key(METADATA_URL, 'k')).rejects.toThrow('jwks_uri must use https');
    const empty = microsoftFetch({ keys: [{ kty: 'EC', kid: 'ec', crv: 'P-256', x: 'x', y: 'y' }] });
    await expect(new BotFrameworkKeyStore(empty.fetch, () => 0).key(METADATA_URL, 'ec')).rejects.toThrow('no usable RSA signing keys');
  });

  it('the adapter verifies with the app id as audience only (no secret needed)', async () => {
    const key = await signingKey();
    const ms = microsoftFetch({ keys: [key.jwk] });
    const adapter = createMsTeamsAdapter({ fetch: ms.fetch, now: () => NOW });
    const config = { ...mtConfig(), secrets: {} };
    expect(await adapter.verifyRequest(teamsRequest(activity(), await connectorToken(key, { aud: APP_ID })), config)).toEqual({ kind: 'verified' });
  });
});
