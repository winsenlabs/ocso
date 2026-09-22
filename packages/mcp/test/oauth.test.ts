import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  McpAuthRequiredError,
  McpDiscoveryService,
  McpOAuthError,
  McpOAuthService,
  McpToolProvider,
  parseOAuthTokenState,
  serializeClientInformation,
  serializeOAuthTokenState,
  type CompleteAuthorizationResult,
  type McpConnectionTarget,
} from '../src/index.js';
import { startTestAuthServer, type TestAuthServer } from './helpers/auth-server.js';
import { startDemo, type DemoServer } from './helpers/demo-server.js';
import { deps, InMemoryCredentials, listen, LOCAL_POLICY, target } from './helpers/fixtures.js';

const REDIRECT = 'http://localhost:3000/api/mcp/oauth/callback';

/** Plays the admin's browser: follow the authorize URL to the (auto-approving) AS and read the callback. */
async function approveInBrowser(authorizationUrl: string): Promise<URLSearchParams> {
  const res = await fetch(authorizationUrl, { redirect: 'manual' });
  expect(res.status).toBe(302);
  const location = new URL(res.headers.get('location') ?? '');
  expect(location.origin + location.pathname).toBe(REDIRECT);
  return location.searchParams;
}

async function reason(p: Promise<unknown>): Promise<string> {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(McpOAuthError);
  return (err as McpOAuthError).reason;
}

describe('OAuth 2.1 redirect flow against the SDK demo authorization server', () => {
  let as: TestAuthServer;
  let rs: DemoServer;
  const oauth = new McpOAuthService({ egress: LOCAL_POLICY });

  beforeAll(async () => {
    as = await startTestAuthServer({ expectedResource: () => rs.url });
    rs = await startDemo((mcpUrl) => ({
      mode: 'oauth',
      verifier: as.verifierFor(mcpUrl),
      oauthMetadata: as.metadata,
      resourceServerUrl: mcpUrl,
      scopesSupported: ['meridian:read', 'meridian:write'],
      allowInsecureIssuer: true,
    }));
  });
  afterEach(() => as.patchMetadata(null));
  afterAll(async () => {
    await rs.close();
    await as.close();
  });

  const oauthTarget = (over: Partial<McpConnectionTarget> = {}) => target(rs.url, over);

  async function authorize(): Promise<CompleteAuthorizationResult> {
    const begun = await oauth.beginAuthorization(oauthTarget(), { redirectUri: REDIRECT });
    const cb = await approveInBrowser(begun.authorizationUrl);
    return oauth.completeAuthorization(begun.pending, { code: cb.get('code'), state: cb.get('state'), iss: cb.get('iss') });
  }

  function connect(result: CompleteAuthorizationResult, creds = new InMemoryCredentials()) {
    creds.secrets.set('secret://tokens', serializeOAuthTokenState(result.tokenState));
    creds.secrets.set('secret://client', serializeClientInformation(result.clientInformation));
    const t = oauthTarget({
      auth: {
        strategy: 'OAUTH',
        tokenRef: 'secret://tokens',
        issuer: result.issuer,
        clientId: result.clientInformation.clientId,
        clientInfoRef: 'secret://client',
        scopes: result.scopes,
      },
    });
    return { creds, t };
  }

  it('detects McpAuthRequired with RFC 9728 metadata when called without credentials', async () => {
    const err = await new McpDiscoveryService(deps()).discover(oauthTarget()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpAuthRequiredError);
    expect((err as McpAuthRequiredError).authRequired).toEqual({
      reason: 'unauthorized',
      resourceMetadataUrl: `${rs.origin}/.well-known/oauth-protected-resource/mcp`,
      resource: rs.url,
      authorizationServers: [as.issuer],
      scopesSupported: ['meridian:read', 'meridian:write'],
      challengedScope: null,
      oauthAvailable: true,
    });
  });

  it('runs begin → consent → callback → token exchange, then discovers and calls tools with the tokens', async () => {
    const begun = await oauth.beginAuthorization(oauthTarget(), { redirectUri: REDIRECT });
    const url = new URL(begun.authorizationUrl);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: 'code',
      code_challenge_method: 'S256',
      redirect_uri: REDIRECT,
      resource: rs.url,
      scope: 'meridian:read meridian:write',
      state: begun.pending.state,
      client_id: begun.pending.clientInformation.clientId,
    });
    expect(begun.pending).toMatchObject({ issuer: as.issuer, resource: rs.url, network: 'INTERNAL', connectionId: 'conn-meridian' });
    expect(begun.pending.clientInformation.registration).toBe('DYNAMIC');
    expect(begun.pending.state).toHaveLength(43);

    const cb = await approveInBrowser(begun.authorizationUrl);
    const result = await oauth.completeAuthorization(begun.pending, { code: cb.get('code'), state: cb.get('state') });
    expect(result.tokens.accessToken).toMatch(/^at_/);
    expect(result.tokens.refreshToken).toMatch(/^rt_/);
    expect(result.tokens.expiresAt).toBeGreaterThan(Date.now());
    expect(result.tokenState).toMatchObject({ issuer: as.issuer, resource: rs.url });
    expect(result.scopes).toEqual(['meridian:read', 'meridian:write']);

    const { creds, t } = connect(result);
    const discovered = await new McpDiscoveryService(deps(creds)).discover(t);
    expect(discovered.tools).toHaveLength(7);
    const provider = new McpToolProvider({ target: t, deps: deps(creds) });
    const outcome = await provider.invoke({ toolCallId: 'c1', toolName: 'crm.get_customer', args: { cif: '88214' }, timeoutMs: 5_000 });
    expect(outcome).toMatchObject({ status: 'SUCCEEDED', output: { type: 'json', value: { name: 'Priya Deshmukh' } } });
    await provider.close();
  });

  it('rejects a callback whose state does not match (constant-time compare)', async () => {
    const begun = await oauth.beginAuthorization(oauthTarget(), { redirectUri: REDIRECT });
    const cb = await approveInBrowser(begun.authorizationUrl);
    expect(await reason(oauth.completeAuthorization(begun.pending, { code: cb.get('code'), state: 'forged' }))).toBe('state_mismatch');
    expect(await reason(oauth.completeAuthorization(begun.pending, { code: cb.get('code') }))).toBe('state_mismatch');
  });

  it('rejects a mismatching RFC 9207 iss, and a missing one when the AS advertises support', async () => {
    const begun = await oauth.beginAuthorization(oauthTarget(), { redirectUri: REDIRECT });
    const cb = await approveInBrowser(begun.authorizationUrl);
    const q = { code: cb.get('code'), state: cb.get('state') };
    expect(await reason(oauth.completeAuthorization(begun.pending, { ...q, iss: 'https://evil.example/' }))).toBe('issuer_mismatch');

    as.patchMetadata({ authorization_response_iss_parameter_supported: true });
    const strict = await oauth.beginAuthorization(oauthTarget(), { redirectUri: REDIRECT });
    const cb2 = await approveInBrowser(strict.authorizationUrl);
    const q2 = { code: cb2.get('code'), state: cb2.get('state') };
    expect(await reason(oauth.completeAuthorization(strict.pending, q2))).toBe('issuer_mismatch');
    const ok = await oauth.completeAuthorization(strict.pending, { ...q2, iss: as.issuer });
    expect(ok.tokens.accessToken).toMatch(/^at_/);
  });

  it('refuses authorization servers that do not advertise PKCE S256', async () => {
    as.patchMetadata({ code_challenge_methods_supported: undefined });
    expect(await reason(oauth.beginAuthorization(oauthTarget(), { redirectUri: REDIRECT }))).toBe('pkce_unsupported');
    as.patchMetadata({ code_challenge_methods_supported: ['plain'] });
    expect(await reason(oauth.beginAuthorization(oauthTarget(), { redirectUri: REDIRECT }))).toBe('pkce_unsupported');
  });

  it('expires pending authorizations and validates the redirect URI', async () => {
    const begun = await oauth.beginAuthorization(oauthTarget(), { redirectUri: REDIRECT });
    const later = new McpOAuthService({ egress: LOCAL_POLICY, now: () => Date.now() + 11 * 60_000 });
    expect(await reason(later.completeAuthorization(begun.pending, { code: 'x', state: begun.pending.state }))).toBe('pending_expired');
    expect(await reason(oauth.beginAuthorization(oauthTarget(), { redirectUri: 'http://ocso.example.com/cb' }))).toBe('invalid_redirect_uri');
  });

  it('surfaces an AS error on the callback as authorization_denied without echoing error_description', async () => {
    const begun = await oauth.beginAuthorization(oauthTarget(), { redirectUri: REDIRECT });
    const err = await oauth.completeAuthorization(begun.pending, { state: begun.pending.state, error: 'access_denied' }).catch((e: unknown) => e);
    expect(err).toMatchObject({ reason: 'authorization_denied', oauthError: 'access_denied' });
  });

  it('registers clients CIMD → pre-registered → DCR, keyed by issuer', async () => {
    const cimd = 'https://ocso.example.com/.well-known/ocso-mcp-client.json';
    const pre = { clientId: 'admin-entered', clientSecret: 's3cret' };
    const withoutSupport = await oauth.beginAuthorization(oauthTarget(), { redirectUri: REDIRECT, clientMetadataUrl: cimd, preRegistered: pre });
    expect(withoutSupport.pending.clientInformation).toEqual({ issuer: as.issuer, clientId: 'admin-entered', clientSecret: 's3cret', registration: 'PRE_REGISTERED' });

    as.patchMetadata({ client_id_metadata_document_supported: true });
    const withSupport = await oauth.beginAuthorization(oauthTarget(), { redirectUri: REDIRECT, clientMetadataUrl: cimd, preRegistered: pre });
    expect(withSupport.pending.clientInformation).toEqual({ issuer: as.issuer, clientId: cimd, registration: 'CLIENT_ID_METADATA_DOCUMENT' });
    expect(new URL(withSupport.authorizationUrl).searchParams.get('client_id')).toBe(cimd);

    const existing = { issuer: 'https://other-issuer.example/', clientId: 'old', registration: 'DYNAMIC' as const };
    const fresh = await oauth.beginAuthorization(oauthTarget(), { redirectUri: REDIRECT, existingClient: existing });
    expect(fresh.pending.clientInformation.registration).toBe('DYNAMIC'); // other issuer's credentials are never reused
  });

  it('refreshes tokens with the SDK helper (rotation preserved)', async () => {
    const result = await authorize();
    const before = as.refreshGrants;
    const refreshed = await oauth.refresh({
      issuer: result.issuer,
      clientInformation: result.clientInformation,
      refreshToken: result.tokens.refreshToken as string,
      resource: result.resource,
      network: 'INTERNAL',
    });
    expect(as.refreshGrants).toBe(before + 1);
    expect(refreshed.accessToken).not.toBe(result.tokens.accessToken);
    expect(refreshed.refreshToken).not.toBe(result.tokens.refreshToken);
    const again = oauth.refresh({
      issuer: result.issuer,
      clientInformation: result.clientInformation,
      refreshToken: result.tokens.refreshToken as string,
      resource: result.resource,
      network: 'INTERNAL',
    });
    expect(await reason(again)).toBe('refresh_rejected'); // rotated: the old refresh token is dead (invalid_grant)
  });

  it('refreshes on 401 at runtime and persists the rotated tokens through the CredentialPort', async () => {
    const result = await authorize();
    const { creds, t } = connect(result);
    as.expireAccessTokens();
    const provider = new McpToolProvider({ target: t, deps: deps(creds) });
    const outcome = await provider.invoke({ toolCallId: 'c2', toolName: 'emi.get_schedule', args: { cif: '88214' }, timeoutMs: 5_000 });
    expect(outcome.status).toBe('SUCCEEDED');
    expect(creds.refreshed).toHaveLength(1);
    const stored = parseOAuthTokenState(creds.secrets.get('secret://tokens') as string);
    expect(stored.accessToken).not.toBe(result.tokens.accessToken);
    expect(stored).toMatchObject({ issuer: as.issuer, resource: rs.url });
    expect(creds.refreshed[0]).toMatchObject({ connectionId: 'conn-meridian', tokenRef: 'secret://tokens', issuer: as.issuer });
    await provider.close();
  });

  it('refreshes proactively when the access token is about to expire', async () => {
    const result = await authorize();
    const soon = { ...result, tokenState: { ...result.tokenState, expiresAt: Date.now() + 5_000 } };
    const { creds, t } = connect(soon);
    const before = as.refreshGrants;
    await new McpDiscoveryService(deps(creds)).discover(t);
    expect(as.refreshGrants).toBe(before + 1);
    expect(creds.refreshed).toHaveLength(1);
  });

  it('turns a dead grant into McpAuthRequired (OAuth available) without leaking tokens', async () => {
    const result = await authorize();
    const dead = { ...result, tokenState: { ...result.tokenState, refreshToken: 'rt_revoked-refresh-token' } };
    const { creds, t } = connect(dead);
    as.expireAccessTokens();
    const err = await new McpDiscoveryService(deps(creds)).discover(t).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpAuthRequiredError);
    const info = (err as McpAuthRequiredError).authRequired;
    expect(info).toMatchObject({ oauthAvailable: true, authorizationServers: [as.issuer] });
    const text = JSON.stringify({ message: (err as Error).message, details: (err as McpAuthRequiredError).details, info });
    expect(text).not.toContain('rt_revoked-refresh-token');
    expect(text).not.toContain(result.tokens.accessToken);
  });

  it('reports insufficient_scope (step-up needed) with the challenged scope instead of re-authorizing silently', async () => {
    const result = await authorize();
    const strictRs = await startDemo((mcpUrl) => ({
      mode: 'oauth',
      verifier: as.verifierFor(new URL(rs.url)),
      oauthMetadata: as.metadata,
      resourceServerUrl: mcpUrl,
      requiredScopes: ['meridian:admin'],
      allowInsecureIssuer: true,
    }));
    const { creds, t } = connect(result);
    const err = await new McpDiscoveryService(deps(creds)).discover({ ...t, url: strictRs.url }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpAuthRequiredError);
    expect((err as McpAuthRequiredError).authRequired).toMatchObject({ reason: 'insufficient_scope', challengedScope: 'meridian:admin' });
    await strictRs.close();
  });

  it('never sends tokens minted by a different issuer (credentials keyed by issuer)', async () => {
    const result = await authorize();
    const foreign = { ...result, tokenState: { ...result.tokenState, issuer: 'https://other-issuer.example/' } };
    const { creds, t } = connect(foreign);
    const err = await new McpDiscoveryService(deps(creds)).discover(t).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpAuthRequiredError);
    expect((err as McpAuthRequiredError).authRequired.reason).toBe('issuer_mismatch');
  });
});

describe('OAuth discovery failures', () => {
  const oauth = new McpOAuthService({ egress: LOCAL_POLICY });

  it('refuses servers without protected-resource metadata', async () => {
    const demo = await startDemo({ mode: 'bearer', token: 'static-token-value-123456' });
    expect(await reason(oauth.beginAuthorization(target(demo.url), { redirectUri: REDIRECT }))).toBe('no_resource_metadata');
    await demo.close();
  });

  it('refuses PRM whose resource does not cover the MCP server URL', async () => {
    const srv = await listen((req, res) => {
      if (req.url?.startsWith('/.well-known/oauth-protected-resource')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ resource: 'https://elsewhere.example/mcp', authorization_servers: ['https://as.example/'] }));
        return;
      }
      res.writeHead(401, { 'www-authenticate': 'Bearer error="invalid_token"' }).end();
    });
    expect(await reason(oauth.beginAuthorization(target(`${srv.origin}/mcp`), { redirectUri: REDIRECT }))).toBe('resource_mismatch');
    await srv.close();
  });
});
