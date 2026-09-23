import { createHash, X509Certificate } from 'node:crypto';
import { z } from 'zod';
import type { authSsoProviders } from '@ocso/db';

const Domain = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, 'a domain such as example.com');

const Common = {
  /** URL-safe id used in callback URLs: /api/auth/sso/callback/<providerId>. */
  providerId: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{1,62}$/, 'lowercase letters, digits and dashes'),
  name: z.string().trim().min(1).max(80),
  domains: z.array(Domain).min(1).max(20),
  autoProvision: z.boolean().default(false),
};

export const SsoProviderInput = z.discriminatedUnion('type', [
  z.object({
    ...Common,
    type: z.literal('oidc'),
    oidc: z.object({
      issuer: z.url().max(500),
      clientId: z.string().trim().min(1).max(500),
      clientSecret: z.string().min(1).max(2000),
      discoveryEndpoint: z.url().max(500).optional(),
      scopes: z.array(z.string().max(100)).max(20).default(['openid', 'email', 'profile']),
    }),
  }),
  z.object({
    ...Common,
    type: z.literal('saml'),
    saml: z
      .object({
        entryPoint: z.url().max(1000),
        /** IdP signing certificate (PEM). */
        certificate: z.string().min(40).max(20_000),
        idpEntityId: z.string().trim().min(1).max(500).optional(),
        metadataXml: z.string().max(100_000).optional(),
        emailAttribute: z.string().max(200).optional(),
        nameAttribute: z.string().max(200).optional(),
      })
      .refine((s) => s.metadataXml || s.idpEntityId, 'the IdP entity ID is required without metadata XML'),
  }),
]);
export type SsoProviderInput = z.input<typeof SsoProviderInput>;

export const SsoProviderPatch = z.object({
  name: Common.name.optional(),
  domains: Common.domains.optional(),
  autoProvision: z.boolean().optional(),
});
export type SsoProviderPatch = z.infer<typeof SsoProviderPatch>;

/** Secret-free view: what the Tech admin needs to configure the IdP side. */
export interface SsoProviderView {
  providerId: string;
  name: string;
  type: 'oidc' | 'saml';
  issuer: string;
  domains: string[];
  autoProvision: boolean;
  /** Redirect URI (OIDC) or ACS URL (SAML) to register at the IdP. */
  callbackUrl: string;
  oidc: { clientId: string; discoveryEndpoint: string | null; scopes: string[] } | null;
  saml: { entryPoint: string | null; spEntityId: string; spMetadataUrl: string; certificateFingerprint: string | null; certificateExpiresAt: string | null } | null;
  createdAt: string;
}

function parse(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function certificateFacts(pem: string | null): { fingerprint: string | null; expiresAt: string | null } {
  if (!pem) return { fingerprint: null, expiresAt: null };
  try {
    const body = pem.includes('BEGIN CERTIFICATE') ? pem : `-----BEGIN CERTIFICATE-----\n${pem}\n-----END CERTIFICATE-----`;
    const cert = new X509Certificate(body);
    return { fingerprint: cert.fingerprint256, expiresAt: new Date(cert.validTo).toISOString() };
  } catch {
    return { fingerprint: createHash('sha256').update(pem).digest('hex').slice(0, 16), expiresAt: null };
  }
}

export function toSsoProviderView(row: typeof authSsoProviders.$inferSelect, publicUrl: string): SsoProviderView {
  const origin = new URL(publicUrl).origin;
  const oidc = parse(row.oidcConfig);
  const saml = parse(row.samlConfig);
  const type = saml ? 'saml' : 'oidc';
  const metadataUrl = `${origin}/api/auth/sso/saml2/sp/metadata?providerId=${encodeURIComponent(row.providerId)}`;
  const idp = (saml?.['idpMetadata'] ?? {}) as Record<string, unknown>;
  const cert = certificateFacts(str(idp['cert']) ?? str(saml?.['cert']));
  return {
    providerId: row.providerId,
    name: row.name,
    type,
    issuer: row.issuer,
    domains: row.domain.split(',').map((d) => d.trim()).filter(Boolean),
    autoProvision: row.autoProvision,
    callbackUrl: type === 'saml' ? `${origin}/api/auth/sso/saml2/sp/acs/${encodeURIComponent(row.providerId)}` : `${origin}/api/auth/sso/callback/${encodeURIComponent(row.providerId)}`,
    oidc: oidc
      ? { clientId: str(oidc['clientId']) ?? '', discoveryEndpoint: str(oidc['discoveryEndpoint']), scopes: Array.isArray(oidc['scopes']) ? oidc['scopes'].filter((s): s is string => typeof s === 'string') : [] }
      : null,
    saml: saml ? { entryPoint: str(saml['entryPoint']), spEntityId: row.issuer, spMetadataUrl: metadataUrl, certificateFingerprint: cert.fingerprint, certificateExpiresAt: cert.expiresAt } : null,
    createdAt: row.createdAt.toISOString(),
  };
}
