/**
 * Better Auth server for OCSO (ADR-025). A separate entry point
 * (`@ocso/application/auth-server`) so processes that never authenticate
 * browsers (the worker) do not load Better Auth.
 */
export { createAuthServer, countSessions, COOKIE_PREFIX, RESET_TOKEN_TTL_SECONDS, type AuthServer, type AuthServerConfig, type AuthServerDeps, type AuthSession } from './server.js';
export { HTTP_AUTH_ENDPOINTS, PENDING_MFA_ENDPOINTS, SIGN_IN_METHODS } from './endpoints.js';
export { SsoProviderService, SsoProviderInput, SsoProviderPatch, type SsoProviderView } from './sso-admin.js';
export { decideProvisioning, type ProvisioningFacts } from './sso-resolver.js';
export { CLIENT_IP_HEADER, emailDomainMatches, sessionTokenOf } from './request.js';
export type { AuthLog } from './audit.js';
