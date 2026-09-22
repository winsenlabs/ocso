/**
 * Plain data contracts and ports for OCSO's MCP connectivity (ADR-021).
 *
 * Everything here is framework-free and storage-agnostic: the API layer
 * persists these shapes, this package only reads them. Secrets are always
 * referenced (`*Ref`) and resolved through {@link CredentialPort} inside
 * trusted code; resolved values are only ever placed on outbound HTTP.
 */

/** Where a connection's server lives. `INTERNAL` unlocks allowlisted private hosts (see {@link EgressPolicy}). */
export type McpNetwork = 'PUBLIC' | 'INTERNAL';

export type McpAuthConfig =
  | { strategy: 'NONE' }
  | {
      strategy: 'HEADER';
      /** e.g. `X-API-Key` or `Authorization`. */
      headerName: string;
      /** Secret reference; resolves to the header value (for `Authorization`, a bare token gets `Bearer `). */
      tokenRef: string;
    }
  | {
      strategy: 'OAUTH';
      /** Secret reference; resolves to a serialized {@link StoredOAuthTokenState}. */
      tokenRef: string;
      /** Authorization-server issuer the tokens were minted by (credentials are keyed by issuer). */
      issuer: string;
      clientId: string;
      /** Secret reference; resolves to serialized {@link McpOAuthClientInformation} (needed when a client secret exists). */
      clientInfoRef?: string | undefined;
      scopes: readonly string[];
    };

export interface McpConnectionTarget {
  id: string;
  /** Admin-facing connection name; also the prefix of model-facing tool names. */
  name: string;
  /** Streamable HTTP endpoint, e.g. `https://mcp.example.com/mcp`. */
  url: string;
  network: McpNetwork;
  auth: McpAuthConfig;
}

/**
 * Outbound (egress) policy. Hosts are exact hostnames / IP literals, or
 * `*.suffix` wildcards (subdomains only). Matching is case-insensitive.
 */
export interface EgressPolicy {
  /** Private/loopback hosts reachable by connections whose network is `INTERNAL`. */
  allowedInternalHosts: readonly string[];
  /** Hosts that may be contacted over plain `http:` (dev / compose only). Everything else is https-only. */
  allowInsecureHttpHosts: readonly string[];
}

export interface EgressLimits {
  /** Redirect hops followed for GET/HEAD (other methods never follow). Default 3. */
  maxRedirects: number;
  /** Per-response body cap. Default 8 MiB. */
  maxResponseBytes: number;
  /** TCP+TLS connect deadline. Default 10 s. */
  connectTimeoutMs: number;
  /** Socket inactivity deadline. Default 120 s. */
  idleTimeoutMs: number;
  /** Whole-request deadline applied only when the caller passes no AbortSignal. Default 30 s. */
  defaultRequestTimeoutMs: number;
}

/** A resolved DNS answer. */
export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/** DNS resolver; injectable for tests. Defaults to `dns.promises.lookup(host, { all: true })`. */
export type DnsResolver = (hostname: string) => Promise<ResolvedAddress[]>;

/** OAuth token set in OCSO's own (SDK-independent) shape. `expiresAt` is epoch ms. */
export interface McpOAuthTokens {
  accessToken: string;
  tokenType: string;
  refreshToken?: string | undefined;
  expiresAt?: number | undefined;
  scope?: string | undefined;
}

/** What an OAUTH connection's `tokenRef` must resolve to (JSON, see `serializeOAuthTokenState`). */
export interface StoredOAuthTokenState extends McpOAuthTokens {
  /** Issuer that minted these tokens; must equal the connection's `auth.issuer`. */
  issuer: string;
  /** RFC 8707 resource the grant is bound to (reused on refresh). */
  resource?: string | undefined;
}

export type ClientRegistrationMethod = 'CLIENT_ID_METADATA_DOCUMENT' | 'PRE_REGISTERED' | 'EXISTING' | 'DYNAMIC';

/** OAuth client credentials, keyed by the issuer that knows them. May carry a secret — store via a secret ref. */
export interface McpOAuthClientInformation {
  issuer: string;
  clientId: string;
  clientSecret?: string | undefined;
  /** Epoch seconds; 0/undefined = never. */
  clientSecretExpiresAt?: number | undefined;
  registration: ClientRegistrationMethod;
}

export interface TokensRefreshedEvent {
  connectionId: string;
  tokenRef: string;
  issuer: string;
  state: StoredOAuthTokenState;
  /** `state` serialized exactly as `tokenRef` must resolve to it. */
  serialized: string;
}

/**
 * Secret access for MCP credentials. Implemented by the API/worker layer on
 * top of the secret store. Values are never logged, returned to browsers or
 * put in model context by this package.
 */
export interface CredentialPort {
  /** Resolve a secret reference. Reject if the reference does not exist. */
  resolve(ref: string): Promise<string>;
  /** Persist rotated/refreshed OAuth tokens under `tokenRef` (called after every successful refresh). */
  onTokensRefreshed(event: TokensRefreshedEvent): Promise<void>;
}

/** Implementation info OCSO sends to servers (`clientInfo`). */
export interface McpClientIdentity {
  name: string;
  version: string;
}

/** Dependencies shared by the discovery, health and tool-provider services. */
export interface McpServiceDeps {
  credentials: CredentialPort;
  egress: EgressPolicy;
  limits?: Partial<EgressLimits> | undefined;
  /** DNS override (tests / custom resolvers). */
  resolver?: DnsResolver | undefined;
  clientIdentity?: McpClientIdentity | undefined;
}

/** Protected-resource metadata discovered when a server demands auth (RFC 9728 + WWW-Authenticate). */
export interface McpAuthRequired {
  reason: 'unauthorized' | 'forbidden' | 'insufficient_scope' | 'credentials_missing' | 'token_rejected' | 'issuer_mismatch';
  /** `resource_metadata` from the challenge, or the well-known URL that served the PRM. */
  resourceMetadataUrl: string | null;
  /** PRM `resource`. */
  resource: string | null;
  authorizationServers: string[];
  scopesSupported: string[];
  /** `scope` from the `WWW-Authenticate` challenge, if any. */
  challengedScope: string | null;
  /** True when the server publishes PRM with at least one authorization server (OAuth is possible). */
  oauthAvailable: boolean;
}
