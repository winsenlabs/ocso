import { acquireCredential } from '../shared/sdk-helpers.js';

/** Token scopes (research/01 §4-5). */
export const AZURE_OPENAI_SCOPE = 'https://cognitiveservices.azure.com/.default';
export const AZURE_AI_SCOPE = 'https://ai.azure.com/.default';

export interface EntraCredentials {
  tenantId?: string | undefined;
  clientId?: string | undefined;
  clientSecret?: string | undefined;
}

/**
 * Microsoft Entra ID bearer tokens. A service principal (tenant + client id +
 * secret) when all three are configured; otherwise DefaultAzureCredential
 * (managed identity / workload identity; `clientId` selects a user-assigned
 * identity). `@azure/identity` is imported lazily and caches/refreshes tokens.
 */
export function entraTokenProvider(creds: EntraCredentials, scope: string): () => Promise<string> {
  let provider: Promise<() => Promise<string>> | undefined;
  return () =>
    acquireCredential('A Microsoft Entra ID token', async () => {
      provider ??= import('@azure/identity').then((identity) => {
        const credential =
          creds.tenantId && creds.clientId && creds.clientSecret
            ? new identity.ClientSecretCredential(creds.tenantId, creds.clientId, creds.clientSecret)
            : new identity.DefaultAzureCredential(creds.clientId ? { managedIdentityClientId: creds.clientId } : {});
        return identity.getBearerTokenProvider(credential, scope);
      });
      return (await provider)();
    });
}

/**
 * `fetch` that sets a fresh `Authorization: Bearer` header per request. Used
 * for Claude on Foundry, where `@ai-sdk/anthropic` only takes a static token.
 */
export function bearerFetch(getToken: () => Promise<string>, base: typeof fetch = globalThis.fetch): typeof fetch {
  return async (input, init) => {
    const headers = new Headers(init?.headers);
    headers.delete('x-api-key');
    headers.set('authorization', `Bearer ${await getToken()}`);
    return base(input, { ...init, headers });
  };
}
