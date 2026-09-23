# @ocso/mcp — MCP connectivity

OCSO is an MCP **client**. This package connects to admin-registered MCP servers. It discovers and
normalizes their tools, runs OAuth 2.1, checks health, and executes approved tool calls through the
`ToolProvider` contract from `@ocso/tools`. The design is in ADR-014, ADR-021 and
`PM/research/03-mcp-and-oauth.md`.

The package is framework-free and storage-agnostic. Services take plain config plus injected ports
and return plain data. The NestJS API layer persists everything. Credentials are never placed in
model context. They are resolved through `CredentialPort` inside trusted code and written only onto
outbound HTTP requests to the connection's own origin.

SDK: `@modelcontextprotocol/client` 2.0.0, used with `versionNegotiation: { mode: 'auto' }`.

## Public API

| Export | Purpose |
|---|---|
| `McpConnectionTarget`, `McpAuthConfig`, `EgressPolicy`, `CredentialPort`, `McpServiceDeps` | Plain config and ports |
| `McpDiscoveryService.discover(target, opts?)` | Returns server info, protocol version/era, capabilities, tools (sanitized, hashed, risk-seeded, model-named) and latency |
| `McpOAuthService.beginAuthorization / completeAuthorization / refresh` | Server-side OAuth redirect flow |
| `McpHealthService.health(target, opts?)` | Returns `HEALTHY` / `DEGRADED` / `DOWN` / `AUTH_REQUIRED`. Never throws |
| `McpToolProvider` | Implements `ToolProvider`. `invoke(call)` returns a `ToolOutcome` |
| `createGuardedFetch(...)` | The SSRF-guarded fetch every request uses. Exported for other egress |
| `serializeOAuthTokenState` / `parseOAuthTokenState`, `serializeClientInformation` / `parseClientInformation` | The exact secret formats that `tokenRef` and `clientInfoRef` resolve to |
| `unionScopes` | Step-up scope union |
| Errors | `McpAuthRequiredError` (with `authRequired: McpAuthRequired`), `EgressBlockedError`, `McpConnectionError`, `McpNetworkError`, `McpCredentialError`, `McpOAuthError` (`reason` discriminant). All extend `DomainError`, and their messages are safe to log and show |

## Connection lifecycle

1. **Admin enters a URL.** Call `discover(target)` with `auth: { strategy: 'NONE' }`.
   - **Success.** Show the tools for review.
   - **`McpAuthRequiredError`.** `authRequired` holds `reason`, `resourceMetadataUrl`, `resource`,
     `authorizationServers`, `scopesSupported`, `challengedScope` and `oauthAvailable`.
     - `oauthAvailable: true` means the server publishes RFC 9728 metadata with an authorization server. Offer OAuth.
     - Otherwise, offer a static header token.
   - **`EgressBlockedError`.** The URL violates the egress policy. See `reason`.
   - **`McpConnectionError`.** The server is unreachable, timed out, returned an HTTP error, or failed protocol negotiation.
2. **Authenticate.** Use a header token (store the secret, set `tokenRef`) or run the OAuth flow below.
3. **Discover again** with credentials. Persist each tool's `schemaHash` (sha256 of the canonical
   JSON of `{name, inputSchema}`) and `definitionHash` (name, title, description, schemas and
   annotations), plus the result's `toolSetHash`.
4. **Review and approve.** `suggestedRisk` is seeded from annotations. Annotations are untrusted
   hints, and missing annotations yield `SENSITIVE`. `description` is sanitized but is still
   **data**, so never splice it into prompts unreviewed. `modelName` is provider-safe and unique
   within the connection. Colliding names get a stable hash suffix.
5. **Monitor.** Call `health(target)` on a schedule. Re-run `discover` periodically. If a
   `definitionHash` changes, re-approval is required, because a description change is a
   prompt-injection vector.
6. **Runtime.** Use one `McpToolProvider` per connection, invoked only after `ToolAuthorizer`
   allows a call (ADR-014).
   - Call `close()` when the connection config or credentials change.
   - Pass `onAuthFailure` to flip the connection to `AUTH_REQUIRED`.

## Auth strategies

| Strategy | Config | `tokenRef` resolves to |
|---|---|---|
| `NONE` | — | — |
| `HEADER` | `headerName`, `tokenRef` | The header value. For `Authorization`, a bare token gets `Bearer `. Protocol-owned headers are rejected, for example `content-type`, `mcp-*` and `x-ocso-customer-claims`. |
| `OAUTH` | `tokenRef`, `issuer`, `clientId`, `clientInfoRef?`, `scopes` | `serializeOAuthTokenState({accessToken, tokenType, refreshToken?, expiresAt?, scope?, issuer, resource})` |

`clientInfoRef`, when set, resolves to `serializeClientInformation(...)`. It is needed when the
client has a secret (DCR or pre-registered clients).

Credentials are **keyed by issuer**. A token state whose `issuer` differs from `auth.issuer` is never
sent (`reason: 'issuer_mismatch'`). Client information is only reused for the issuer that issued it.

**Runtime refresh.** `token()` refreshes proactively within 60 s of expiry. A 401 triggers one
refresh (single-flight) and one retry, using the SDK's `refreshAuthorization`. Every refresh calls
`CredentialPort.onTokensRefreshed({ connectionId, tokenRef, issuer, state, serialized })`.
**Persist `serialized` under `tokenRef` before resolving.** Refresh tokens rotate. If a refresh is
lost, the grant is dead.

A dead grant (`invalid_grant` or no refresh token) surfaces as `McpAuthRequired` (`token_rejected`).

## OAuth redirect flow (server-side)

```ts
const oauth = new McpOAuthService({ egress });
// POST /mcp-connections/:id/authorize
const { authorizationUrl, pending } = await oauth.beginAuthorization(target, {
  redirectUri: 'https://ocso.example.com/api/mcp/oauth/callback',
  clientMetadataUrl: 'https://ocso.example.com/.well-known/ocso-mcp-client.json', // optional (CIMD)
  preRegistered: { clientId, clientSecret },                                      // optional (admin-entered)
  existingClient,                                                                 // optional (same issuer only)
  scopes,                                                                         // optional (e.g. step-up union)
});
// persist `pending` server-side, keyed by pending.state; 302 the browser to authorizationUrl

// GET /api/mcp/oauth/callback?code&state&iss
const pending = await pendingStore.takeOnce(query.state);   // single-use; delete even on failure
const r = await oauth.completeAuthorization(pending, { code, state, iss, error });
// persist: secrets[tokenRef] = serializeOAuthTokenState(r.tokenState)
//          secrets[clientInfoRef] = serializeClientInformation(r.clientInformation)   (if clientSecret)
//          connection.auth = { strategy:'OAUTH', tokenRef, issuer: r.issuer, clientId: r.clientInformation.clientId, clientInfoRef, scopes: r.scopes }
```

**Begin**, in order:
- Unauthenticated probe. The `WWW-Authenticate` challenge supplies `resource_metadata` and `scope`.
- RFC 9728 PRM. Refused when missing.
- PRM `resource` must cover the MCP URL.
- Choose the authorization server. The target's `issuer` is used when it is listed. Otherwise the
  first listed server, or `options.authorizationServer`.
- RFC 8414 / OIDC discovery with the issuer-echo check (SDK).
- **Refuse unless `code_challenge_methods_supported` includes `S256`.**
- Authorization and token endpoints must use https. Plain http is allowed only for
  `allowInsecureHttpHosts`.
- Client registration, in this order:
  1. CIMD (when `clientMetadataUrl` is given and the AS advertises support)
  2. pre-registered
  3. existing credentials for the same issuer
  4. DCR (`application_type: 'web'`)
- `startAuthorization` generates PKCE S256 and sends `state` (32 random bytes) and `resource` (RFC 8707).

**Complete**, in order:
- Expiry check.
- **Constant-time `state` comparison.**
- **RFC 9207 `iss`:** a mismatch is rejected. A missing `iss` is rejected when the AS advertises
  `authorization_response_iss_parameter_supported`.
- The AS's `error` is reported as `authorization_denied` with only the error code.
  `error_description` is never accepted or echoed.
- `exchangeAuthorization` sends `resource` again.
- Returns `tokens`, `issuer`, `clientInformation`, `resource`, `scopes` and `tokenState`.

**What `pending` contains.** It holds the PKCE verifier, the AS metadata snapshot, and possibly a
DCR client secret. Store it server-side only, encrypted, single-use, with a TTL of 10 minutes by
default. Never send it to the browser.

**Step-up.** A 403 `insufficient_scope` becomes `McpAuthRequired` with `reason: 'insufficient_scope'`
and `challengedScope`. Re-run `beginAuthorization` with
`scopes: unionScopes(auth.scopes, challengedScope)` behind an admin action. The transport never
re-authorizes silently.

All failures throw `McpOAuthError` with one of these `reason` values:
- Input and callback: `invalid_redirect_uri`, `pending_expired`, `state_mismatch`, `authorization_denied`, `missing_code`
- Discovery and metadata: `no_resource_metadata`, `resource_mismatch`, `no_authorization_server`, `authorization_server_not_listed`, `no_authorization_server_metadata`, `incompatible_authorization_server`, `issuer_mismatch`, `pkce_unsupported`, `insecure_endpoint`
- Client registration: `invalid_client_metadata_url`, `registration_unavailable`, `registration_rejected`
- Tokens: `token_exchange_failed`, `refresh_unavailable`, `refresh_rejected`, `refresh_failed`

## SSRF / egress policy

```ts
const egress: EgressPolicy = {
  allowedInternalHosts: ['meridian-core', '*.svc.internal'], // reachable only by network: 'INTERNAL' connections
  allowInsecureHttpHosts: ['meridian-core'],                 // http allowed only here; everything else is https-only
};
```

Every request goes through `createGuardedFetch`: MCP traffic, PRM, AS metadata, registration, token
and refresh requests.
- **Scheme and URL.** `https:` only, unless the host is allowlisted for http. URLs containing
  userinfo are rejected.
- **Always blocked**, even for allowlisted hosts:
  - IPv4: link-local 169.254/16 (cloud metadata, ECS 169.254.170.2), 0/8, multicast, 240/4, documentation/benchmark ranges
  - IPv6: `::`, `fe80::/10`, `ff00::/8`
  - IPv4-mapped IPv6 (`::ffff:*`) and IPv4-embedding forms (compatible, NAT64, 6to4, Teredo)
- **Internal ranges.** Loopback, RFC 1918, CGNAT and IPv6 ULA are reachable only when **the
  connection's `network` is `INTERNAL` and its host is in `allowedInternalHosts`**. Exact match, or
  `*.suffix`.
- **Literal IPs** are checked before connecting. Canonical URL parsing means `2130706433` is
  treated as `127.0.0.1`.
- **Hostnames** are resolved by a custom `lookup`. It validates **every** DNS answer and hands the
  socket only validated addresses, which closes the DNS-rebinding window. The resolver is
  injectable (`deps.resolver`).
- **Redirects** are followed for GET/HEAD only, up to 3 hops. Each hop is re-validated. Cross-origin
  hops drop `Authorization`, custom credential headers and everything else except `accept`,
  `accept-language`, `user-agent` and `mcp-protocol-version`. POST redirects are never followed.
- **Limits** (`deps.limits`):

  | Limit | Default |
  |---|---|
  | Connect timeout | 10 s |
  | Idle timeout | 120 s |
  | Whole-request deadline, when the caller passes no signal (the OAuth helpers) | 30 s |
  | Response size cap | 8 MiB |

- **Keep-alive pools** are per guarded-fetch instance, meaning per policy and network. A socket to
  an allowlisted internal host is never reused under a stricter policy.
- **Docker Compose.** The demo lives on a private network, so allowlist its service name in both
  lists and give the connection `network: 'INTERNAL'`.

## Protocol negotiation

- **Negotiation.** Clients use `'auto'`: they probe `server/discover` (2026-07-28, stateless) and
  fall back to the 2025 `initialize` handshake. An HTTP 401/403, a 5xx or a timeout on the probe is
  an error, not a fallback.
- **Client settings.** Clients declare no capabilities and set `inputRequired.autoFulfill: false`,
  so servers cannot elicit through OCSO.
- **Pagination.** `listTools` walks all pages. The cap is `maxPages`, default 20. Hitting the cap
  fails with a typed error; a partial catalogue is never returned.
- **Health checks.** Health calls `discover()` on modern servers and `ping()` only on 2025-era
  servers. `ping` does not exist in 2026-07-28.
- **Sessions.** Sessionful 2025 servers are sent `DELETE` (terminate session) on close.

## Tool calls (`McpToolProvider.invoke`)

**Result mapping:**
- `structuredContent` becomes `{type:'json'}`.
- Otherwise the text blocks are joined into `{type:'text'}`. Media is summarized, never inlined.
- `isError` becomes `FAILED tool_rejected`. The message carries the tool's text, sanitized,
  truncated and with credentials redacted. An `isError` whose text starts with the SDK servers'
  `Input validation error` prefix becomes `validation` instead.

**Thrown failures** map to a fixed safe message:

| Failure | `errorCategory` |
|---|---|
| Network error, 5xx/404/429, unreachable, egress-blocked, auth rejected | `tool_unavailable` |
| Deadline hit | `timeout` |
| Caller aborted | `internal` (cancelled) |
| Server `InvalidParams` (invalid arguments or unknown tool) | `validation` |
| Other 4xx, output-schema violation, malformed response | `tool_rejected` |

Messages never carry raw exception text, server bodies or tokens. Resolved secrets and the claims
value are redacted from outputs.

**Other behaviour:**
- **Output validation.** Pass `approvedTool` to validate `structuredContent` against the
  **admin-approved** `outputSchema` (SDK `toolDefinition`).
- **Retries.** A call is never retried. `timeout` or `tool_unavailable` after sending means the
  call MAY have executed. Retry writes only with the same idempotency key.
- **Reconnects.** After auth or transport failures, the pooled client is dropped. The next call
  reconnects and re-resolves credentials.

### Per-call headers: customer claims and idempotency

- `Idempotency-Key: <call.idempotencyKey>` is sent on every call that provides one.
- `X-OCSO-Customer-Claims: <call.customerClaims>` is sent **only when the provider is constructed
  with `trusted: true`**. Otherwise it is dropped.
- Values must be visible ASCII. Keys are capped at 255 characters and claims at 8 KiB.

These headers use the SDK's per-request `RequestOptions.headers`. The Streamable HTTP transport
applies them to exactly that POST. There is no shared mutable fetch state, so concurrent calls for
different customers cannot cross-contaminate. The SDK refuses to override `authorization`,
`content-type` and `mcp-*`.

## Known gaps / UNVERIFIED

- **OAuth tested against one AS only.** It was tested against the v1 SDK in-memory AS (with
  refresh rotation added in the test helper). It was not tested against Okta, Entra, Auth0 or
  Keycloak.
- **CIMD is only half-tested.** The CIMD path is exercised up to the authorize URL, because the
  test AS cannot fetch metadata documents. OCSO must host the CIMD JSON itself.
- **`private_key_jwt` and `client_credentials`** (M2M) connections are not wired. Use
  `createPrivateKeyJwtAuth` / `ClientCredentialsProvider` from the SDK when needed.
- **Cross-process refresh races.** Single-flight works within one process only. With several
  workers, make `onTokensRefreshed` compare-and-swap, or add a distributed lock, so a rotated
  refresh token is not lost.
- **Deprecated HTTP+SSE-only servers** are not supported. There is no `SSEClientTransport`
  fallback.
- **SSRF gaps.**
  - There is no egress proxy (Smokescreen) integration.
  - CIDR entries in `allowedInternalHosts` are not supported (hostnames and IP literals only).
  - Custom CA bundles come only via `NODE_EXTRA_CA_CERTS`.
- **Response size cap.** The cap applies per response. A very long-lived SSE stream counts
  cumulatively.
- **Standalone GET SSE streams.** A 2025 sessionful server's GET SSE stream is subject to the
  120 s idle timeout, and the SDK reconnects it.
- **Tool-list change notifications** (`list_changed`, `subscriptions/listen`) are not consumed.
  Drift detection is poll-based via `discover`.
- **Tool-output validation errors** are detected by matching SDK 2.0.0 message text. Re-verify this
  on SDK upgrades.
