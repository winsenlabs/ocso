import 'server-only';
import { ROLES } from '@ocso/auth';
import { z } from 'zod';
import { ObjectApprovalStateSchema, ProposedSchema } from '@/components/approvals/lib/schemas';
import { api } from './client';

/** Tech admin authentication settings (ADR-025): MFA policy and SSO providers. */
const AuthPolicy = z.object({ requireMfaRoles: z.array(z.enum(ROLES)), updatedAt: z.string().nullable() });
export type AuthPolicy = z.infer<typeof AuthPolicy>;

const SsoProvider = z.object({
  /** Row id: the object id of its approvals. */
  id: z.string(),
  providerId: z.string(),
  /** DRAFT until approved (sign-in refused), ACTIVE, or DISABLED. */
  status: z.enum(['DRAFT', 'ACTIVE', 'DISABLED']).catch('ACTIVE').default('ACTIVE'),
  approval: ObjectApprovalStateSchema.nullable().catch(null).default(null),
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
/** Part of the deployment settings: a proposal (202) naming its checker (PM/research/11 §4). */
export const saveAuthPolicy = (requireMfaRoles: string[], approval: { checkerId: string; reason: string } | { bootstrap: true; reason: string }) => api.put('/v1/settings/auth-policy', { requireMfaRoles, approval }, z.union([ProposedSchema, AuthPolicy]));
export const listSsoProviders = () => api.get('/v1/settings/sso-providers', z.array(SsoProvider));
export const createSsoProvider = (input: SsoProviderInput) => api.post('/v1/settings/sso-providers', input, SsoProvider, { timeoutMs: 20_000 });
/** A draft changes directly; an approved provider answers 409 approval_required until `approval` names a checker (202). */
export const updateSsoProvider = (providerId: string, patch: { autoProvision?: boolean; name?: string; domains?: string[]; approval?: { checkerId: string; reason: string } | { bootstrap: true; reason?: string | undefined } | undefined }) =>
  api.patch(`/v1/settings/sso-providers/${encodeURIComponent(providerId)}`, patch, z.union([SsoProvider, ProposedSchema]));
export const deleteSsoProvider = (providerId: string) => api.command('DELETE', `/v1/settings/sso-providers/${encodeURIComponent(providerId)}`);
