export * from './types.js';
export * from './errors.js';
export { canonicalJson, sha256Hex } from './canonical-json.js';

export { classifyAddress, hostMatches, normalizeHost, type AddressClass } from './egress/address-policy.js';
export {
  assertUrlAllowed,
  createGuardedFetch,
  DEFAULT_EGRESS_LIMITS,
  systemResolver,
  type FetchFn,
  type GuardedFetch,
  type GuardedFetchOptions,
} from './egress/guarded-fetch.js';

export { buildAuthRequired, parseChallenge, probeAuthChallenge, type AuthChallenge } from './auth/challenge.js';

export { createClientHandle, DEFAULT_CLIENT_IDENTITY, type ClientConnectOptions, type McpClientHandle } from './client/client-handle.js';
export { classifyMcpError, type ClassifiedFailure, type McpFailureKind } from './client/classify-error.js';
export { toTypedMcpError } from './client/to-typed-error.js';

export { McpDiscoveryService, type DiscoverOptions, type McpDiscoveryResult } from './discovery/discovery-service.js';
export { normalizeTools, toolSetHash, type DiscoveredTool } from './discovery/tool-normalizer.js';

export { McpOAuthService, constantTimeEqual, type McpOAuthServiceDeps } from './oauth/oauth-service.js';
export type {
  BeginAuthorizationOptions,
  BeginAuthorizationResult,
  CompleteAuthorizationResult,
  McpPendingAuthorization,
  OAuthCallbackQuery,
} from './oauth/types.js';
export type { ClientRegistrationOptions } from './oauth/registration.js';
export { refreshOAuthTokens, type RefreshTokensInput } from './oauth/refresh.js';
export { unionScopes } from './oauth/scopes.js';
export {
  isExpiring,
  parseClientInformation,
  parseOAuthTokenState,
  serializeClientInformation,
  serializeOAuthTokenState,
} from './oauth/token-state.js';

export { McpHealthService, type HealthOptions, type McpHealthResult, type McpHealthStatus } from './health/health-service.js';

export {
  CUSTOMER_CLAIMS_HEADER,
  USER_TOKEN_HEADER,
  IDEMPOTENCY_KEY_HEADER,
  McpToolProvider,
  type ApprovedToolDefinition,
  type McpToolProviderOptions,
} from './provider/mcp-tool-provider.js';
export { contentText, mapCallError, mapCallResult, redactSecrets } from './provider/result-mapper.js';
