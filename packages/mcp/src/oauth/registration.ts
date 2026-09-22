import {
  registerClient,
  validateClientMetadataUrl,
  type AuthorizationServerMetadata,
} from '@modelcontextprotocol/client';
import { McpOAuthError } from '../errors.js';
import type { FetchFn } from '../egress/guarded-fetch.js';
import type { McpOAuthClientInformation } from '../types.js';
import { mapOAuthHelperError } from './sdk-errors.js';

export interface ClientRegistrationOptions {
  /** OCSO-hosted Client ID Metadata Document URL (https, non-root path). Preferred when the AS supports CIMD. */
  clientMetadataUrl?: string | undefined;
  /** Admin-entered client credentials for ASes without CIMD/DCR. */
  preRegistered?: { clientId: string; clientSecret?: string | undefined } | undefined;
  /** Credentials from an earlier authorization; reused only when issued by the same issuer. */
  existingClient?: McpOAuthClientInformation | undefined;
  /** `client_name` for Dynamic Client Registration. Default `OCSO`. */
  clientName?: string | undefined;
}

export interface RegistrationContext {
  authorizationServerUrl: string;
  metadata: AuthorizationServerMetadata;
  redirectUri: string;
  scope: string | undefined;
  fetchFn: FetchFn;
}

function pickTokenEndpointAuthMethod(metadata: AuthorizationServerMetadata): string {
  const supported = metadata.token_endpoint_auth_methods_supported;
  if (!supported || supported.includes('client_secret_basic')) return 'client_secret_basic';
  if (supported.includes('client_secret_post')) return 'client_secret_post';
  return 'none';
}

/**
 * Client registration, in ADR-021 order: Client ID Metadata Document (when
 * a URL is configured and the AS advertises support) → admin pre-registered
 * → existing credentials for the same issuer → Dynamic Client Registration
 * (deprecated in 2026-07-28, kept as fallback). Credentials are always
 * stamped with the issuer they belong to.
 */
export async function resolveClientRegistration(
  ctx: RegistrationContext,
  options: ClientRegistrationOptions,
): Promise<McpOAuthClientInformation> {
  const issuer = ctx.metadata.issuer;
  const cimdSupported = (ctx.metadata as Record<string, unknown>)['client_id_metadata_document_supported'] === true;

  if (options.clientMetadataUrl && cimdSupported) {
    try {
      validateClientMetadataUrl(options.clientMetadataUrl);
    } catch {
      throw new McpOAuthError('invalid_client_metadata_url');
    }
    return { issuer, clientId: options.clientMetadataUrl, registration: 'CLIENT_ID_METADATA_DOCUMENT' };
  }
  if (options.preRegistered) {
    return {
      issuer,
      clientId: options.preRegistered.clientId,
      ...(options.preRegistered.clientSecret ? { clientSecret: options.preRegistered.clientSecret } : {}),
      registration: 'PRE_REGISTERED',
    };
  }
  if (options.existingClient && options.existingClient.issuer === issuer) {
    return { ...options.existingClient, registration: 'EXISTING' };
  }
  if (!ctx.metadata.registration_endpoint) throw new McpOAuthError('registration_unavailable');

  try {
    const full = await registerClient(ctx.authorizationServerUrl, {
      metadata: ctx.metadata,
      clientMetadata: {
        client_name: options.clientName ?? 'OCSO',
        redirect_uris: [ctx.redirectUri],
        application_type: 'web',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: pickTokenEndpointAuthMethod(ctx.metadata),
      },
      ...(ctx.scope ? { scope: ctx.scope } : {}),
      fetchFn: ctx.fetchFn,
    });
    return {
      issuer,
      clientId: full.client_id,
      ...(full.client_secret ? { clientSecret: full.client_secret } : {}),
      ...(full.client_secret_expires_at ? { clientSecretExpiresAt: full.client_secret_expires_at } : {}),
      registration: 'DYNAMIC',
    };
  } catch (err) {
    throw mapOAuthHelperError(err, 'registration_rejected');
  }
}
