import 'server-only';
import { ROLES } from '@ocso/auth';
import { z } from 'zod';
import { api } from './client';

/** Tech Admin authentication settings (ADR-025): MFA policy and SSO providers. */
const AuthPolicy = z.object({ requireMfaRoles: z.array(z.enum(ROLES)), updatedAt: z.string().nullable() });
export type AuthPolicy = z.infer<typeof AuthPolicy>;

const SsoProvider = z.object({
  providerId: z.string(),
  name: z.string(),
  type: z.enum(['oidc', 'saml']),
  issuer: z.string(),
  domains: z.array(z.string()),
  autoProvision: z.boolean(),
  callbackUrl: z.string(),
  oidc: z.object({ clientId: z.string(), discoveryEndpoint: z.string().nullable(), scopes: z.array(z.string()) }).nullable(),
  saml: z
    .object({
      entryPoint: z.string().nullable(),
      spEntityId: z.string(),
      spMetadataUrl: z.string(),
      certificateFingerprint: z.string().nullable(),
      certificateExpiresAt: z.string().nullable(),
    })
    .nullable(),
  createdAt: z.string(),
});
export type SsoProvider = z.infer<typeof SsoProvider>;

export type SsoProviderInput =
  | { providerId: string; name: string; type: 'oidc'; domains: string[]; autoProvision: boolean; oidc: { issuer: string; clientId: string; clientSecret: string } }
  | {
      providerId: string;
      name: string;
      type: 'saml';
      domains: string[];
      autoProvision: boolean;
      saml: { entryPoint: string; certificate: string; idpEntityId?: string; metadataXml?: string };
    };

export const getAuthPolicy = () => api.get('/v1/settings/auth-policy', AuthPolicy);
export const saveAuthPolicy = (requireMfaRoles: string[]) => api.put('/v1/settings/auth-policy', { requireMfaRoles }, AuthPolicy);
export const listSsoProviders = () => api.get('/v1/settings/sso-providers', z.array(SsoProvider));
export const createSsoProvider = (input: SsoProviderInput) => api.post('/v1/settings/sso-providers', input, SsoProvider, { timeoutMs: 20_000 });
export const updateSsoProvider = (providerId: string, patch: { autoProvision?: boolean; name?: string; domains?: string[] }) =>
  api.patch(`/v1/settings/sso-providers/${encodeURIComponent(providerId)}`, patch, SsoProvider);
export const deleteSsoProvider = (providerId: string) => api.command('DELETE', `/v1/settings/sso-providers/${encodeURIComponent(providerId)}`);
