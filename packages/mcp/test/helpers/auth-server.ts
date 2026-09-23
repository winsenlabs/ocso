import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { DemoInMemoryClientsStore } from '@modelcontextprotocol/sdk/examples/server/demoInMemoryOAuthProvider.js';
import { InvalidGrantError, InvalidTargetError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { createOAuthMetadata, mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { OAuthError, OAuthErrorCode, type OAuthMetadata, type OAuthTokenVerifier } from '@modelcontextprotocol/server';
import { listen, type RunningServer } from './fixtures.js';

/**
 * Test OAuth 2.1 authorization server built on the legacy v1 SDK's
 * `mcpAuthRouter` + in-memory client store (research/03 §4: the v2 SDK has
 * no AS). Auto-approves, supports DCR and PKCE, and — unlike the stock demo
 * provider — issues and rotates refresh tokens and binds tokens to the
 * RFC 8707 resource. Metadata can be patched per test (e.g. drop S256).
 */
const require = createRequire(import.meta.url);
// express is untyped in this package (types live with the demo); keep the surface we use explicit.
const express = require('express') as { (): ExpressApp; json(): unknown; urlencoded(o: object): unknown };
interface ExpressApp {
  use(...handlers: unknown[]): void;
  get(path: string, handler: (req: unknown, res: { json(body: unknown): void }, next: () => void) => void): void;
}

interface CodeRecord {
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  scopes: string[];
  resource: string | undefined;
}
interface TokenRecord {
  clientId: string;
  scopes: string[];
  resource: string | undefined;
  expiresAt: number;
}

export interface TestAuthServer extends RunningServer {
  issuer: string;
  metadata: OAuthMetadata;
  /** Shallow patch applied to the served RFC 8414 document (`undefined` values remove fields). */
  patchMetadata(patch: Record<string, unknown> | null): void;
  /** Resource-server verifier: active token AND audience === the MCP resource. */
  verifierFor(resource: URL): OAuthTokenVerifier;
  expireAccessTokens(): void;
  refreshGrants: number;
}

export async function startTestAuthServer(options: { expectedResource: () => string; accessTtlSec?: number }): Promise<TestAuthServer> {
  const running = await listen();
  const issuerUrl = new URL(`${running.origin}/`);
  const codes = new Map<string, CodeRecord>();
  const access = new Map<string, TokenRecord>();
  const refresh = new Map<string, TokenRecord>();
  let patch: Record<string, unknown> | null = null;
  const state = { refreshGrants: 0 };
  const ttl = options.accessTtlSec ?? 3600;

  const issue = (rec: Omit<TokenRecord, 'expiresAt'>) => {
    const accessToken = `at_${randomUUID()}`;
    const refreshToken = `rt_${randomUUID()}`;
    access.set(accessToken, { ...rec, expiresAt: Date.now() + ttl * 1000 });
    refresh.set(refreshToken, { ...rec, expiresAt: Date.now() + 86_400_000 });
    return { access_token: accessToken, token_type: 'bearer', expires_in: ttl, refresh_token: refreshToken, scope: rec.scopes.join(' ') };
  };
  const checkResource = (resource: URL | string | undefined) => {
    if (!resource || String(resource) !== options.expectedResource()) throw new InvalidTargetError('invalid resource');
  };

  const provider = {
    clientsStore: new DemoInMemoryClientsStore(),
    async authorize(client: { client_id: string; redirect_uris: string[] }, params: Record<string, unknown>, res: { redirect(url: string): void }) {
      const redirectUri = String(params['redirectUri']);
      if (!client.redirect_uris.includes(redirectUri)) throw new Error('Unregistered redirect_uri');
      const code = randomUUID();
      codes.set(code, {
        clientId: client.client_id,
        codeChallenge: String(params['codeChallenge']),
        redirectUri,
        scopes: (params['scopes'] as string[] | undefined) ?? [],
        resource: params['resource'] ? String(params['resource']) : undefined,
      });
      const target = new URL(redirectUri);
      target.searchParams.set('code', code);
      if (params['state'] !== undefined) target.searchParams.set('state', String(params['state']));
      res.redirect(target.href);
    },
    async challengeForAuthorizationCode(_client: unknown, code: string) {
      const rec = codes.get(code);
      if (!rec) throw new Error('Invalid authorization code');
      return rec.codeChallenge;
    },
    async exchangeAuthorizationCode(client: { client_id: string }, code: string, _v?: string, _r?: string, resource?: URL) {
      const rec = codes.get(code);
      if (!rec || rec.clientId !== client.client_id) throw new InvalidGrantError('Invalid authorization code');
      codes.delete(code);
      checkResource(resource ?? rec.resource);
      return issue({ clientId: rec.clientId, scopes: rec.scopes, resource: rec.resource });
    },
    async exchangeRefreshToken(client: { client_id: string }, refreshToken: string, _scopes?: string[], resource?: URL) {
      const rec = refresh.get(refreshToken);
      if (!rec || rec.clientId !== client.client_id) throw new InvalidGrantError('Invalid refresh token');
      checkResource(resource);
      refresh.delete(refreshToken); // rotation
      state.refreshGrants++;
      return issue({ clientId: rec.clientId, scopes: rec.scopes, resource: rec.resource });
    },
    async verifyAccessToken(token: string) {
      const rec = access.get(token);
      if (!rec || rec.expiresAt < Date.now()) throw new Error('Invalid or expired token');
      return { token, clientId: rec.clientId, scopes: rec.scopes, expiresAt: Math.floor(rec.expiresAt / 1000), resource: rec.resource ? new URL(rec.resource) : undefined };
    },
  };

  const metadata = createOAuthMetadata({ provider: provider as never, issuerUrl, scopesSupported: ['meridian:read', 'meridian:write'] }) as OAuthMetadata;
  const app = express();
  app.get('/.well-known/oauth-authorization-server', (_req, res, next) => (patch ? res.json({ ...metadata, ...patch }) : next()));
  app.use(
    mcpAuthRouter({
      provider: provider as never,
      issuerUrl,
      scopesSupported: ['meridian:read', 'meridian:write'],
      authorizationOptions: { rateLimit: false },
      clientRegistrationOptions: { rateLimit: false },
      tokenOptions: { rateLimit: false },
    }),
  );
  running.server.on('request', app as never);

  return {
    ...running,
    issuer: issuerUrl.href,
    metadata,
    patchMetadata: (p) => {
      patch = p;
    },
    verifierFor: (resource) => ({
      async verifyAccessToken(token) {
        const rec = access.get(token);
        if (!rec || rec.expiresAt < Date.now()) throw new OAuthError(OAuthErrorCode.InvalidToken, 'inactive token');
        if (rec.resource !== resource.href) throw new OAuthError(OAuthErrorCode.InvalidToken, 'wrong audience');
        return { token, clientId: rec.clientId, scopes: rec.scopes, expiresAt: Math.floor(rec.expiresAt / 1000) };
      },
    }),
    expireAccessTokens: () => {
      for (const rec of access.values()) rec.expiresAt = 0;
    },
    get refreshGrants() {
      return state.refreshGrants;
    },
  };
}
