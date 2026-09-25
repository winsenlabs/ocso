# 03: MCP client, OAuth, and the demo MCP server

Researched 2026-09-22. **Method:** I read the spec at modelcontextprotocol.io (the 2026-07-28 changelog, authorization pages, security best practices, and `schema/2026-07-28/schema.ts` from GitHub) and the typescript-sdk repo (README and `docs/migration/*.md`). I also installed `@modelcontextprotocol/sdk@1.30.0`, `@modelcontextprotocol/{client,server,core,express,node}@2.0.0`, `@ai-sdk/mcp@2.0.55` and `ai@7.0.109`, then read their `.d.mts` files and compiled JS. Everything below was run end to end on Node 26.8.1: the demo server, static-bearer clients, the full server-side OAuth redirect flow against a toy AS, `insufficient_scope`, and the SSRF guard. All of it type-checks under `tsc` 7.0.2 strict. The scripts are in a scratch directory.

Labels:
- **VERIFIED(run)**: I ran it.
- **VERIFIED(code)**: I read it in the shipped `.d.mts`/JS or the spec.
- **UNVERIFIED**: everything else.

## TL;DR

- **The current spec is `2026-07-28`, not 2025-11-25.** It is a breaking revision:
  - It is **stateless**. There is no `initialize` handshake, no `Mcp-Session-Id` and no `ping`.
  - A new mandatory `server/discover` call exists.
  - Every request carries its protocol version, client info and capabilities in `_meta`.
  - Server-to-client requests are replaced by `input_required` results.
  - **Dynamic Client Registration is now deprecated** in favour of Client ID Metadata Documents (CIMD).
  - New auth MUSTs: validate the RFC 9207 `iss`, and bind stored credentials to the issuer.
- **The TypeScript SDK is now split into v2 packages.** `@modelcontextprotocol/client` and `/server` 2.0.0 (plus `/express`, `/node`, `/hono`, `/fastify` adapters) shipped 2026-07-27 as "the stable release line".
  - `@modelcontextprotocol/sdk@1.30.0` (v1) only speaks the 2025 protocol versions. It gets bug and security fixes for at least 6 months.
  - **Use v2.** It talks to both protocol generations: 2025-era servers and 2026-07-28 servers. VERIFIED(run): a v2 client reached both, and a v1 client talked to the v2 server.
- **OAuth (server-side web flow):** build it from the SDK's exported primitives:
  - `discoverOAuthServerInfo`
  - `startAuthorization`
  - `exchangeAuthorization` (validates `iss`)
  - `refreshAuthorization`
  - `registerClient`

  At runtime, feed tokens through the minimal `AuthProvider {token, onUnauthorized}`. This runs in about 150 LOC with no hand-rolled OAuth. VERIFIED(run) end to end.

  **We must add three things ourselves:**
  1. The PKCE-support refusal. The SDK only checks `code_challenge_methods_supported` when it is present.
  2. `state` validation. The SDK explicitly does not do it.
  3. An SSRF-guarded `fetch`. The SDK uses global `fetch` with no guard.
- **The v2 server has no Authorization Server (AS).** `mcpAuthRouter` and `ProxyOAuthServerProvider` moved to the frozen `@modelcontextprotocol/server-legacy/auth`, and the docs say to "migrate AS to a dedicated IdP".
  - For the demo, use a static bearer token.
  - For OAuth tests, run the v1 demo AS, which auto-approves. VERIFIED(run).
- **AI SDK:** `@ai-sdk/mcp@2.0.55` has `createMCPClient` (alias `experimental_createMCPClient`), but `ai@7` does not re-export it. It is lighter, but its OAuth support lags the spec. **Recommendation:** use the official v2 client inside OCSO's gateway, and hand the model gated `dynamicTool`s built from the approved schemas.

## 1. Spec 2026-07-28: what matters for OCSO

**Versioning**
- Current is `2026-07-28` (modelcontextprotocol.io/specification/versioning). Earlier revisions (2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05) are "handshake-based".
- A version mismatch returns `UnsupportedProtocolVersionError` (-32022).
- HTTP+SSE transport, Roots, Sampling, Logging and DCR are all **Deprecated**, with a removal window of at least 12 months. VERIFIED(code).

**Transport and caching**
- Streamable HTTP POSTs must carry the `MCP-Protocol-Version`, `Mcp-Method` and `Mcp-Name` headers (SEP-2243). Gateways can authorize on these headers without parsing the body.
- A broken response stream loses the in-flight request, and the client must re-issue it. **Never auto-retry a write tool without an idempotency key.**
- `tools/list` results carry `ttlMs` and `cacheScope`, and servers SHOULD return tools in a deterministic order.

**Auth requirements** (basic/authorization plus its sub-pages; all VERIFIED(code) against spec text)
- **Protocol base:** OAuth 2.1 (draft-13) is used only on HTTP transports.
  - PKCE is required. Clients **MUST use S256** and **MUST refuse to proceed if AS metadata lacks `code_challenge_methods_supported`**, whether the metadata came from RFC 8414 or OIDC discovery.
- **Resource discovery (RFC 9728):**
  - Servers MUST serve Protected Resource Metadata (PRM) with at least one entry in `authorization_servers`.
  - Clients MUST use `WWW-Authenticate: Bearer resource_metadata="…"` from the 401 when present.
  - Otherwise clients probe `/.well-known/oauth-protected-resource/<mcp-path>` and then the root `/.well-known/oauth-protected-resource`.
- **AS discovery:** clients MUST support both RFC 8414 and OIDC.
  - For an issuer with a path (`https://a.example/t1`) the order is:
    1. `/.well-known/oauth-authorization-server/t1`
    2. `/.well-known/openid-configuration/t1`
    3. `/t1/.well-known/openid-configuration`
  - With no path: `oauth-authorization-server`, then `openid-configuration`.
  - The `issuer` in the fetched doc **MUST equal** the issuer used to build the URL, or the doc is rejected.
- **Client registration priority:**
  1. Pre-registered.
  2. **CIMD**, used if the AS has `client_id_metadata_document_supported: true`. The `client_id` is an HTTPS URL with a path, and the document needs at least `client_id`, `client_name` and `redirect_uris`. Auth may use `private_key_jwt`.
  3. DCR (RFC 7591, deprecated), used if there is a `registration_endpoint`. DCR MUST send `application_type` (`"web"` for OCSO).
  4. Ask the user.
- **Credentials:** clients MUST key stored client credentials (and tokens) **by the AS `issuer`**, never reuse them across ASes, and re-register when the AS changes.
- **`resource` parameter (RFC 8707):** it is MUST in **both** the authorize and token requests. Its value is the canonical MCP URL (e.g. `https://mcp.example.com/mcp`: lowercase scheme and host, no fragment, no trailing slash by preference). Send it even if the AS ignores it.
- **Audience:**
  - Servers MUST validate that the token audience is themselves.
  - Clients MUST NOT send a token that was not issued by that server's AS.
  - **Token passthrough is forbidden.**
- **Mix-up defence:** record the AS `issuer` alongside the PKCE verifier and `state`. On callback, compare `iss` using exact string compare:
  - If `authorization_response_iss_parameter_supported: true` and `iss` is absent, reject.
  - If `iss` is present, it must match.
  - On a mismatch, **do not display `error_description`**.
- **Scopes:**
  - Initial scope is the `scope` from the `WWW-Authenticate` challenge, else PRM `scopes_supported`, else omit it.
  - At runtime a `403` with `error="insufficient_scope", scope="…"` starts a step-up: re-authorize with the **union** of previously requested scopes and the challenged scopes, and cap the retries.
- **Refresh tokens:** keep them confidential. Include `refresh_token` in `grant_types`. `offline_access` MAY be added if the AS lists it. Never assume a refresh token will be issued. The AS MUST rotate refresh tokens for public clients.
- **HTTPS everywhere:** all AS endpoints must be HTTPS. Redirect URIs must be HTTPS or localhost. Clients should verify `state`.

## 2. Client API (v2): VERIFIED(run) unless noted

```ts
import { Client, StreamableHTTPClientTransport, type Tool } from '@modelcontextprotocol/client';
const client = new Client({ name: 'ocso', version: '1.0.0' }, {
  versionNegotiation: { mode: 'auto' },  // DEFAULT IS 'legacy' (2025 initialize). 'auto' = server/discover probe, falls back
  inputRequired: { autoFulfill: false }, // OCSO: don't let servers elicit via registered handlers (VERIFIED(code))
});
const transport = new StreamableHTTPClientTransport(new URL(url), {
  fetch: guardedFetch,                                   // §5 — used for every MCP HTTP call
  authProvider: { token: async () => vault.access(connId, userId) }, // or OAuthClientProvider; or:
  // requestInit: { headers: { 'X-API-Key': key } },     // static header auth (VERIFIED(run))
  // onInsufficientScope: 'reauthorize' | 'throw', maxStepUpRetries: 1  (defaults)
});
await client.connect(transport, { timeout: 10_000 });   // or { prior: { kind:'modern', discover } } to skip the probe
client.getProtocolEra();            // 'modern' | 'legacy'   → got 'modern' / '2026-07-28'
client.getNegotiatedProtocolVersion(); client.getServerVersion(); client.getServerCapabilities(); client.getInstructions();
// No cursor ⇒ SDK walks every page itself (cap listMaxPages=64, repeat-cursor guard) and caches the aggregate;
// an explicit { cursor } returns one raw page with nextCursor (manual walking). cacheMode: 'use'|'refresh'|'bypass'.
const { tools } = await client.listTools(undefined, { cacheMode: 'refresh' });   // tools: Tool[]
const r = await client.callTool({ name, arguments: args }, {
  timeout: 15_000, signal: ac.signal,    // default timeout 60_000; also resetTimeoutOnProgress, maxTotalTimeout, onprogress
  toolDefinition: approvedTool,          // validate structuredContent against the *admin-approved* outputSchema
});
r.isError; r.content /* ContentBlock[] */; r.structuredContent /* unknown, any JSON (SEP-2106) */;
await client.close();                  // legacy sessionful servers: await transport.terminateSession() first
```
- **Tool shape:**
  - Fields: `name`, `title?`, `description?`, `inputSchema{type:'object',…}`, `outputSchema?`, `annotations?`, `execution?{taskSupport}`, `icons?` and `_meta?`.
  - `annotations` holds `{title?, readOnlyHint?, destructiveHint?, idempotentHint?, openWorldHint?}`. **Spec defaults when absent are readOnly=false, destructive=true, idempotent=false and openWorld=true.** The schema says these are hints and should not drive decisions for untrusted servers.
  - Use them only to *seed* the read/write/sensitive class. Missing values mean "write + destructive" until an admin overrides them.
- **Errors:**
  - A tool that fails reports `isError:true` in the result (VERIFIED(run)).
  - Otherwise the client throws one of: `ProtocolError`; `SdkError` (`code`: `REQUEST_TIMEOUT`, `ERA_NEGOTIATION_FAILED`, `METHOD_NOT_SUPPORTED_BY_PROTOCOL_VERSION`, …); `SdkHttpError`; `UnauthorizedError` (a bad token gave `UnauthorizedError`, VERIFIED(run)); `InsufficientScopeError{requiredScope, resourceMetadataUrl}` (VERIFIED(run)).
- **Health checks:**
  - **`ping()` throws on modern servers** (`METHOD_NOT_SUPPORTED_BY_PROTOCOL_VERSION`, VERIFIED(run)). Use `client.discover({timeout})`; it took 13 ms locally.
  - Legacy servers: use `ping()`.
  - Also re-list tools periodically, hash `(name, description, inputSchema, outputSchema, annotations)`, and flag drift for re-approval. `ai@7` ships `fingerprintTools`/`detectToolDrift`, which do the same over AI SDK ToolSets.
- **Transports:**
  - The `'auto'` probe does not fall back on HTTP 401/403/5xx or on timeouts. It rejects with a typed error.
  - `SSEClientTransport` still exists for the deprecated HTTP+SSE transport. Only fall back to it (try Streamable HTTP first, catch, then try SSE) if a target server needs it.

## 3. OAuth: server-side redirect flow with SDK primitives: VERIFIED(run)

**Flow**
1. The user clicks "Authenticate". `POST /mcp-connections/:id/authorize` returns an `authorizationUrl`.
2. The browser goes to the AS.
3. The AS calls `GET /api/mcp/oauth/callback?code&state&iss`. We store tokens encrypted in the secret store, keyed by `(connectionId, userId|shared, issuer)`.

**Tested run**
- The authorize URL carried `response_type=code`, `client_id`, `code_challenge_method=S256`, `redirect_uri`, `state`, `scope=mcp:tools` and `resource=http://localhost:4101/mcp`.
- The exchange returned tokens, and a modern-era `listTools`/`callTool` with them succeeded.
- A replayed `state` was rejected.

**Snippet** (condensed from `ocso-oauth-flow.ts`)

```ts
import { discoverOAuthServerInfo, extractWWWAuthenticateParams, resourceUrlFromServerUrl, checkResourceAllowed,
  registerClient, startAuthorization, exchangeAuthorization, refreshAuthorization, computeScopeUnion,
  type AuthorizationServerMetadata } from '@modelcontextprotocol/client';

async function begin(connId: string, serverUrl: URL, userId: string | null, stepUpScope?: string) {
  const probe = await guardedFetch(serverUrl, { method: 'POST', headers: { 'content-type': 'application/json',
    accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'tools/list' }) });
  const ch = [401, 403].includes(probe.status) ? extractWWWAuthenticateParams(probe) : {}; // {resourceMetadataUrl, scope, error}
  const info = await discoverOAuthServerInfo(serverUrl, { resourceMetadataUrl: ch.resourceMetadataUrl, fetchFn: guardedFetch });
  if (!info.resourceMetadata) throw new Error('no RFC 9728 PRM');     // SDK would silently fall back to origin-as-AS
  const md = info.authorizationServerMetadata; if (!md) throw new Error('no AS metadata');
  if (!md.code_challenge_methods_supported?.includes('S256')) throw new Error('no PKCE S256'); // SDK gap
  const expected = resourceUrlFromServerUrl(serverUrl);
  if (!checkResourceAllowed({ requestedResource: expected, configuredResource: info.resourceMetadata.resource })) throw new Error('resource mismatch');
  const resource = new URL(info.resourceMetadata.resource);
  const clientInfo = await regs.get(connId, md.issuer)                    // 1) admin pre-registered (keyed by issuer)
    ?? ((md as any).client_id_metadata_document_supported && CIMD_URL ? { client_id: CIMD_URL }   // 2) CIMD
    : await registerClient(info.authorizationServerUrl, { metadata: md, fetchFn: guardedFetch,     // 3) DCR (deprecated)
        clientMetadata: { client_name: 'OCSO', redirect_uris: [REDIRECT_URI], application_type: 'web',
          grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'client_secret_basic' } }));
  await regs.save(connId, md.issuer, clientInfo);                         // RegistrationRejectedError on DCR failure
  const scope = stepUpScope ?? ch.scope ?? info.resourceMetadata.scopes_supported?.join(' ');
  const state = randomBytes(32).toString('base64url');
  const { authorizationUrl, codeVerifier } = await startAuthorization(info.authorizationServerUrl,
    { metadata: md, clientInformation: clientInfo, redirectUrl: REDIRECT_URI, scope, state, resource });
  await pending.insert({ state, connId, userId, codeVerifier, issuer: md.issuer, asUrl: info.authorizationServerUrl,
    asMetadata: md, resource: resource.href, scope, expiresAt: Date.now() + 600_000 });  // single-use, 10 min
  return authorizationUrl; // assert https: before 302 (spec: reject javascript:/data: etc.)
}
async function callback(q: URLSearchParams) {
  const p = await pending.takeOnce(q.get('state'));   // SDK does NOT validate state — this is ours
  if (!p || p.expiresAt < Date.now() || !q.get('code')) throw new Error('authorization failed'); // don't echo error_description
  const tokens = await exchangeAuthorization(p.asUrl, { metadata: p.asMetadata, clientInformation: (await regs.get(p.connId, p.issuer))!,
    authorizationCode: q.get('code')!, iss: q.get('iss') ?? undefined,   // RFC 9207 → IssuerMismatchError
    codeVerifier: p.codeVerifier, redirectUri: REDIRECT_URI, resource: new URL(p.resource), fetchFn: guardedFetch });
  await vault.put(p.connId, p.userId, { ...tokens, issuer: p.issuer, expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000 });
}
// refresh (preserves old refresh_token if AS doesn't rotate): refreshAuthorization(asUrl, { metadata, clientInformation, refreshToken, resource, fetchFn })
// runtime: authProvider: { token: () => vault.access(...), onUnauthorized: () => vault.forceRefresh(...) } → 2nd 401 ⇒ UnauthorizedError ⇒ NEEDS_REAUTH
// step-up: catch InsufficientScopeError ⇒ begin(connId, url, user, computeScopeUnion(grantedScope, e.requiredScope)) behind a UI prompt
```
**Signatures** (VERIFIED(code), v2.0.0):
- `startAuthorization(asUrl, {metadata?, clientInformation, redirectUrl, scope?, state?, resource?}) → {authorizationUrl, codeVerifier}`. It generates S256 PKCE and appends `prompt=consent` when the scope includes `offline_access`.
- `exchangeAuthorization(asUrl, {metadata?, clientInformation, authorizationCode, iss?, codeVerifier, redirectUri, resource?, addClientAuthentication?, fetchFn?})`
- `refreshAuthorization(asUrl, {metadata?, clientInformation, refreshToken, resource?, addClientAuthentication?, fetchFn?})`
- `registerClient(asUrl, {metadata?, clientMetadata, scope?, fetchFn?})`. It is `@deprecated` and throws `RegistrationRejectedError{status, body, submittedMetadata}`.
- `discoverOAuthProtectedResourceMetadata(serverUrl, {protocolVersion?, resourceMetadataUrl?}, fetchFn?)`
- `discoverAuthorizationServerMetadata(asUrl, {fetchFn?, protocolVersion?, skipIssuerValidation?})`. It follows the spec's discovery order and throws `IssuerMismatchError`.

**Behaviour notes**
- Token requests throw `InsecureTokenEndpointError` for non-HTTPS endpoints (loopback exempt).
- Client auth is chosen automatically: `client_secret_basic`, then `client_secret_post`, then `none`.
- For `private_key_jwt`, pass `createPrivateKeyJwtAuth({issuer, subject, privateKey, alg})` as `addClientAuthentication`.
- For shared M2M connections, use `ClientCredentialsProvider({clientId, clientSecret, scope?, expectedIssuer})` directly as `authProvider`.

**Alternative: the `auth()` orchestrator with a DB-backed `OAuthClientProvider`**

`auth(provider, {serverUrl, authorizationCode?, iss?, scope?, resourceMetadataUrl?, fetchFn?, skipIssuerMetadataValidation?, forceReauthorization?}) → 'AUTHORIZED'|'REDIRECT'`
- On begin, the provider's `redirectToAuthorization(url)` captures the URL.
- On callback, call `auth()` again with `authorizationCode` and `iss`, or call `transport.finishAuth(callbackSearchParams)`.

The full provider interface (VERIFIED(code)):

| Member | Notes |
|---|---|
| `get redirectUrl(): string\|URL\|undefined` | `undefined` means a non-interactive flow |
| `clientMetadataUrl?: string` | CIMD URL; used when the AS advertises support |
| `get clientMetadata(): OAuthClientMetadata` | |
| `state?()` | |
| `clientInformation(ctx?: {issuer})` / `saveClientInformation?(info, ctx?)` | Key by `ctx.issuer`. Omitting `save*` disables DCR. |
| `tokens(ctx?)` / `saveTokens(tokens, ctx?)` | When `ctx` is undefined, return the latest set. The SDK stamps `issuer`, which must be round-tripped verbatim. |
| `redirectToAuthorization(url)`, `saveCodeVerifier(v)`, `codeVerifier()` | |
| `addClientAuthentication?(headers, params, url, metadata?)` | |
| `validateResourceURL?(serverUrl, resource?)` | |
| `invalidateCredentials?('all'\|'client'\|'tokens'\|'verifier'\|'discovery')` | |
| `prepareTokenRequest?(scope?)` | |
| `saveDiscoveryState?(s)` / `discoveryState?()` | Must persist like the verifier; used for the callback-leg AS binding check |
| `saveResourceUrl?` / `resourceUrl?` | |
| `saveAuthorizationServerUrl?` / `authorizationServerUrl?` | Both `@deprecated` |

**I prefer the primitives for OCSO:**
- `auth()` silently falls back to the MCP origin as the AS when PRM is missing, picks `authorization_servers[0]`, does no PKCE-absence refusal and no `state` check, and its callback-leg state lives inside the provider.
- An explicit state machine maps cleanly onto admin UI states: `DISCOVERED`, `NEEDS_AUTH`, `AUTHORIZED`, `NEEDS_REAUTH`, `NEEDS_STEP_UP`.

## 4. Demo "bank core" MCP server (v2): VERIFIED(run)

```ts
import express from 'express'; import * as z from 'zod';   // zod ^4 (v2 requires z.object; raw shapes deprecated)
import { McpServer, createMcpHandler, OAuthError, OAuthErrorCode, type OAuthTokenVerifier } from '@modelcontextprotocol/server';
import { requireBearerAuth, mcpAuthMetadataRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
function buildServer() {
  const s = new McpServer({ name: 'bank-core-demo', version: '0.1.0' });
  s.registerTool('get_balance', { title: 'Get account balance', description: 'Read balance (minor units).',
    inputSchema: z.object({ accountId: z.string() }),
    outputSchema: z.object({ accountId: z.string(), balanceMinor: z.number(), currency: z.string() }),
    annotations: { readOnlyHint: true, openWorldHint: false } },
    async ({ accountId }, ctx) => { /* ctx.http?.authInfo = verified token */ const out = lookup(accountId);
      return out ? { content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out }
                 : { isError: true, content: [{ type: 'text', text: 'unknown account' }] }; });
  s.registerTool('transfer_funds', { description: 'Move money. Irreversible.',
    inputSchema: z.object({ from: z.string(), to: z.string(), amountMinor: z.number().int().positive(), idempotencyKey: z.string() }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } }, transfer);
  return s;
}
const handler = createMcpHandler(() => buildServer());     // per-request/stateless; serves 2026-07-28 AND 2025 (legacy:'stateless' default)
const verifier: OAuthTokenVerifier = { async verifyAccessToken(token) {
  if (token !== process.env.BANK_CORE_TOKEN) throw new OAuthError(OAuthErrorCode.InvalidToken, 'bad token'); // must be v2 OAuthError, else 500
  return { token, clientId: 'static', scopes: ['bank:read', 'bank:write'], expiresAt: Math.floor(Date.now() / 1000) + 3600 }; } }; // expiresAt REQUIRED
const app = express(); app.use(express.json());
const mcpUrl = new URL('http://localhost:4100/mcp'), node = toNodeHandler(handler);
app.all('/mcp', requireBearerAuth({ verifier, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl) }),
  (req, res) => node(req, res, req.body));   // MUST pass req.body after express.json() — else "Parse error" (hit this)
// OAuth mode: app.use(mcpAuthMetadataRouter({ oauthMetadata, resourceServerUrl: mcpUrl, scopesSupported: ['mcp:tools'] }))
//   + a verifier that introspects and checks aud === mcpUrl (tested with the toy AS).
```
- A 401 carries `WWW-Authenticate: Bearer error="invalid_token", …, resource_metadata="…/.well-known/oauth-protected-resource/mcp"`. The PRM JSON was served correctly. VERIFIED(run).
- `requiredScopes` makes the server return 403 `insufficient_scope`. VERIFIED(run).
- For a non-localhost bind, use `createMcpExpressApp({host:'0.0.0.0', allowedHosts:[…]})`. It applies Host/Origin (DNS-rebinding) validation.
- **Toy AS for tests:** there is no AS in v2.
  - Option 1: the v1 demo. Run `setupAuthServer({authServerUrl, mcpServerUrl, strictResource:true})` from `@modelcontextprotocol/sdk/examples/server/demoInMemoryOAuthProvider.js` with `MCP_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL=1`. It auto-approves, supports DCR, returns no refresh token and has an `/introspect` endpoint. VERIFIED(run).
  - Option 2: `@modelcontextprotocol/server-legacy/auth` (2.0.0, frozen).
  - Option 3: use Keycloak in Docker Compose if we need refresh, CIMD or `iss` behaviour. UNVERIFIED which of those Keycloak supports.
- **Exposing OCSO's own APIs as an MCP server later:** use the same `createMcpHandler` plus `requireBearerAuth`, with PRM pointing at OCSO's real IdP. The SDK is resource-server-only.

## 5. Security: what OCSO (as a server-side client) must do

- **SSRF.** The URLs in `resource_metadata`, `authorization_servers` and `*_endpoint` are all attacker-controlled. The spec says to use HTTPS only, block private, loopback, link-local (169.254/16) and IPv6 ULA/link-local ranges, re-validate every redirect, beware DNS rebinding, avoid hand-rolled IP parsing, and consider an egress proxy (Smokescreen).
  - Pass a guarded fetch to **every** SDK call (`fetchFn`) and to the transport (`fetch`).
  - VERIFIED(run): 169.254.169.254, 127.0.0.1, `[::ffff:10.0.0.1]` and `localtest.me`→::1 were blocked; `example.com` was allowed. Two findings came out of that run:
    1. The undici `lookup` hook is **not** called for IP-literal hosts, so literals need their own check.
    2. The Docker demo (172.x) needs an explicit host allowlist.
```ts
import { Agent, fetch as undiciFetch } from 'undici'; import ipaddr from 'ipaddr.js'; import dns from 'node:dns';
const bad = (ip: string) => { const r = ipaddr.process(ip).range(); return r !== 'unicast' && !(r === 'loopback' && DEV); };
const agent = new Agent({ connect: { lookup(host: string, o: any, cb: any) { dns.lookup(host, { ...o, all: true }, (e, a: any[]) => {
  if (e) return cb(e); const x = a.find(v => bad(v.address)); if (x) return cb(new Error(`SSRF: ${host}->${x.address}`));
  o.all ? cb(null, a) : cb(null, a[0].address, a[0].family); }); } } as any });   // checks the IP actually dialled (anti-rebinding)
export const guardedFetch = async (input: string | URL, init?: RequestInit) => { let u = new URL(String(input));
  for (let hop = 0; hop < 3; hop++) {
    if (u.protocol !== 'https:' && !DEV) throw new Error('https only');
    const h = u.hostname.replace(/^\[|\]$/g, ''); if (ipaddr.isValid(h) && bad(h)) throw new Error('SSRF: literal IP');
    const res = await undiciFetch(u, { ...(init as any), redirect: 'manual', dispatcher: agent });
    const loc = res.headers.get('location'); if ((init?.method ?? 'GET') === 'GET' && res.status >= 300 && res.status < 400 && loc) { u = new URL(loc, u); continue; }
    return res as unknown as Response; }
  throw new Error('too many redirects'); };
```
- **Token passthrough and confused deputy.**
  - OCSO never forwards a user's OCSO session token to an MCP server.
  - Each MCP connection gets its own token, whose audience is that server's `resource`.
  - If OCSO later *proxies* MCP to third parties, it must obtain per-client consent before redirecting to the third-party AS, match `redirect_uri` exactly, use single-use `state` set only after consent, and protect the consent page with `frame-ancestors`.
- **What the client should validate.** Items marked "(SDK)" are done by the SDK; the rest are ours.
  - PRM `resource` matches the server URL (SDK, via `checkResourceAllowed`).
  - AS metadata `issuer` echo (SDK).
  - PKCE S256 is advertised (ours).
  - The authorization URL scheme is https (ours; the spec also forbids opening URLs via a shell).
  - `state` (ours).
  - `iss` (SDK, in `exchangeAuthorization`).
  - The token endpoint uses TLS (SDK).
  - Credentials are keyed by issuer (ours).
  - The AS is unchanged between begin and callback (ours).
  - Treat tool annotations and descriptions as untrusted, and re-approve on drift (ours).
- **Session / state-handle hijacking.** In 2026-07-28 this is "state handle hijacking": servers must bind the handles they mint to the verified user and never treat a handle as authentication. For 2025-era servers the risk is `Mcp-Session-Id`. OCSO should never let the model choose a connection or user identity. These come from the conversation's authz context, not from tool args.
- **Token storage.** Refresh tokens must be encrypted at rest (the secret store). Never log `Authorization` headers.

## 6. Vercel AI SDK MCP client vs official SDK

- **`@ai-sdk/mcp@2.0.55`** (VERIFIED(code)):
  - API: `createMCPClient({transport: {type:'http'|'sse', url, headers?, authProvider?, redirect?='error', fetch?}, capabilities?})`.
  - Returns `{tools(), listTools(), callTool({name, arguments, options}), toolsFromDefinitions(defs), listResources, readResource, …, close}`.
  - It speaks both 2026-07-28 (it sends `server/discover`) and the 2025-11-25 handshake.
  - `ai@7.0.109` itself has no MCP client export.
- **Pros:**
  - Smaller surface.
  - `toolsFromDefinitions()` yields AI SDK tools directly.
  - `redirect:'error'` is the default.
  - Tool annotations are exposed.
  - It has MCP Apps helpers.
- **Cons for OCSO:**
  - `tools()` binds `execute` straight to `callTool`, so our approval gate would have to wrap every tool anyway.
  - Its `OAuthClientProvider` predates SEP-2352: there is no `issuer` ctx and no `discoveryState`.
  - Its RFC 9207 check only fires when `iss` is present. It misses the rule "advertised but absent means reject".
  - There is no `InsufficientScopeError`/step-up, no response cache and no `toolDefinition`-pinned output validation.
  - It does not export the low-level OAuth primitives we need for a server-side redirect flow.
- **Recommendation:**
  - Use `@modelcontextprotocol/client@2` in an `McpGatewayModule`.
  - Give the model tools built from the **approved** snapshot, e.g. `dynamicTool({ description, inputSchema: jsonSchema(approved.inputSchema), execute: (args) => gate.authorizeThenCall(connId, name, args) })` from `ai` (VERIFIED(run): it compiles and executes).
  - The model sees schemas and results, never credentials.

## 7. UNVERIFIED / open items

- NestJS 12 wiring for `toNodeHandler` (Express adapter with `@Req() req, @Res() res`, passing `req.body`) was not run under Nest.
- Behaviour against real ASes was not tested: Okta, Entra, Auth0, Keycloak, and the CIMD support of the Salesforce/Stripe MCP servers. Many enterprise ASes still lack DCR and CIMD, so plan for admin-entered pre-registered client IDs from day one.
- The CIMD path (`client_id` = OCSO-hosted HTTPS JSON) was not exercised because the toy AS lacks `client_id_metadata_document_supported`. The code path was verified by reading `auth()`.
- Refresh-token rotation was not exercised (the toy AS issues none). `refreshAuthorization` semantics come from reading the code.
- Whether `'auto'` negotiation plus `SSEClientTransport` fallback covers old HTTP+SSE-only servers was not tested.
- There is also `@modelcontextprotocol/conformance@0.1.16` and `@modelcontextprotocol/inspector@2.7.0`. Consider them for CI against the demo server.
