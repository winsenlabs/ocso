import { createHash, timingSafeEqual } from 'node:crypto';
import express, { type Express, type RequestHandler } from 'express';
import {
  getOAuthProtectedResourceMetadataUrl,
  hostHeaderValidation,
  mcpAuthMetadataRouter,
  requireBearerAuth,
} from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, OAuthError, OAuthErrorCode, type OAuthMetadata, type OAuthTokenVerifier } from '@modelcontextprotocol/server';
import { JwksClaimsVerifier } from './claims-jwks.js';
import { readRequestContext, verifiedClaims } from './request-context.js';
import { buildMeridianServer, SERVER_INFO } from './server.js';
import { MeridianStore } from './store.js';

export type MeridianAuth =
  | { mode: 'none' }
  | { mode: 'bearer'; token: string }
  | {
      /** Resource-server mode against an external authorization server (used by OCSO's OAuth tests). */
      mode: 'oauth';
      verifier: OAuthTokenVerifier;
      oauthMetadata: OAuthMetadata;
      /** Public URL of the `/mcp` endpoint (the RFC 8707 resource). */
      resourceServerUrl: URL;
      scopesSupported?: string[];
      requiredScopes?: string[];
      allowInsecureIssuer?: boolean;
    };

export interface MeridianAppOptions {
  auth: MeridianAuth;
  store?: MeridianStore;
  /** HS256 secret for verifying `X-OCSO-Customer-Claims` (tests). */
  claimsSecret?: string | undefined;
  /** OCSO's JWKS URL: verifies the ES256 claims OCSO issues. Takes precedence over `claimsSecret`. */
  claimsJwksUrl?: string | undefined;
  /** Expected claims issuer (OCSO public URL) when verifying via JWKS. */
  claimsIssuer?: string | undefined;
  /** DNS-rebinding protection: allowed `Host` names (recommended when not bound to localhost). */
  allowedHosts?: string[] | undefined;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest();

/** Static bearer verifier. Must throw the v2 OAuthError (anything else becomes a 500) and set `expiresAt`. */
export function staticTokenVerifier(expected: string): OAuthTokenVerifier {
  const expectedHash = sha256(expected);
  return {
    async verifyAccessToken(token) {
      if (!timingSafeEqual(sha256(token), expectedHash)) throw new OAuthError(OAuthErrorCode.InvalidToken, 'Invalid access token');
      return { token, clientId: 'static-bearer', scopes: ['meridian:read', 'meridian:write'], expiresAt: Math.floor(Date.now() / 1000) + 3600 };
    },
  };
}

function authGuards(app: Express, auth: MeridianAuth): RequestHandler[] {
  if (auth.mode === 'none') return [];
  if (auth.mode === 'bearer') return [requireBearerAuth({ verifier: staticTokenVerifier(auth.token) })];
  app.use(
    mcpAuthMetadataRouter({
      oauthMetadata: auth.oauthMetadata,
      resourceServerUrl: auth.resourceServerUrl,
      resourceName: 'Meridian core (demo)',
      ...(auth.scopesSupported ? { scopesSupported: auth.scopesSupported } : {}),
      ...(auth.allowInsecureIssuer ? { dangerouslyAllowInsecureIssuerUrl: true } : {}),
    }),
  );
  return [
    requireBearerAuth({
      verifier: auth.verifier,
      resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(auth.resourceServerUrl),
      ...(auth.requiredScopes ? { requiredScopes: auth.requiredScopes } : {}),
    }),
  ];
}

/** Build the Express app serving `POST /mcp` (both protocol eras, stateless) and `GET /healthz`. */
export function createMeridianApp(options: MeridianAppOptions): { app: Express; store: MeridianStore } {
  const store = options.store ?? new MeridianStore();
  const handler = createMcpHandler((ctx) => buildMeridianServer(store, readRequestContext(ctx.requestInfo, options.claimsSecret)));
  const node = toNodeHandler(handler);

  const app = express();
  app.disable('x-powered-by');
  if (options.allowedHosts?.length) app.use(hostHeaderValidation(options.allowedHosts));
  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok', server: SERVER_INFO });
  });
  app.use(express.json({ limit: '256kb' }));
  const guards = authGuards(app, options.auth);
  // express.json() consumed the stream: the parsed body MUST be passed explicitly (research/03 §4).
  const jwks = options.claimsJwksUrl ? new JwksClaimsVerifier({ jwksUrl: options.claimsJwksUrl, issuer: options.claimsIssuer }) : null;
  app.all('/mcp', ...guards, (req, res) => {
    const raw = req.headers['x-ocso-customer-claims'];
    if (!jwks || typeof raw !== 'string') {
      void node(req, res, req.body);
      return;
    }
    void jwks.verify(raw).then(
      (claims) => verifiedClaims.run({ claims, claimsError: null }, () => node(req, res, req.body)),
      () => verifiedClaims.run({ claims: null, claimsError: 'Customer claims could not be verified.' }, () => node(req, res, req.body)),
    );
  });
  return { app, store };
}
