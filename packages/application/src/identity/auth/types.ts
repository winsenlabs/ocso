/** OCSO's narrow view of the Better Auth instance (ADR-025); everything else stays inside server.ts. */

/** The session as OCSO's guard sees it (Better Auth fields plus OCSO's auth method). */
export interface AuthSession {
  session: { id: string; token: string; userId: string; createdAt: Date; expiresAt: Date; authMethod: string };
  user: { id: string; email: string; name: string; twoFactorEnabled: boolean };
}

/** What OCSO uses from Better Auth; everything else stays inside this module. */
export interface AuthServer {
  /** Fetch-style handler for /api/auth/* (the API mounts it before its body parsers). */
  handler(request: Request): Promise<Response>;
  /** A request's session (Bearer or cookie) through Better Auth, including OCSO's idle gate; null when absent/invalid. */
  getSession(headers: Headers): Promise<AuthSession | null>;
  signOut(headers: Headers): Promise<void>;
  registerSsoProvider(headers: Headers, body: SsoRegistration): Promise<void>;
  deleteSsoProvider(headers: Headers, providerId: string): Promise<void>;
  /** Every Better Auth endpoint (route templates), for the HTTP-surface test. */
  endpointPaths(): string[];
}

/** The subset of Better Auth's SSO registration body OCSO sends. */
export interface SsoRegistration {
  providerId: string;
  issuer: string;
  domain: string;
  name: string;
  autoProvision: boolean;
  oidcConfig?: {
    clientId: string;
    clientSecret: string;
    pkce: boolean;
    skipDiscovery: boolean;
    discoveryEndpoint: string;
    authorizationEndpoint: string;
    tokenEndpoint: string;
    jwksEndpoint: string;
    userInfoEndpoint?: string;
    tokenEndpointAuthentication?: 'client_secret_basic' | 'client_secret_post';
    scopes: string[];
  };
  samlConfig?: {
    entryPoint: string;
    cert: string;
    callbackUrl: string;
    wantAssertionsSigned: boolean;
    idpMetadata: { metadata: string } | { entityID: string; cert: string };
    spMetadata: Record<string, never>;
    mapping: { email: string; name: string };
  };
}
