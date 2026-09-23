import { eq, sql } from 'drizzle-orm';
import type { SSOUserResolution, SSOUserResolutionInput } from '@better-auth/sso';
import { authSsoProviders, users, type Db } from '@ocso/db';
import type { AuthAudit } from './audit.js';
import { emailDomainMatches } from './request.js';

/** What OCSO knows about a provider and a local user, for the provisioning decision. */
export interface ProvisioningFacts {
  email: string;
  providerDomains: string | null;
  autoProvision: boolean;
  existing: { id: string; status: 'ACTIVE' | 'DISABLED' } | null;
}

/**
 * The SSO provisioning policy (ADR-025), as a pure decision:
 * - the email must be on one of the provider's domains (an IdP cannot vouch
 *   for addresses outside what the Tech admin bound it to);
 * - an existing, active OCSO user with that email is linked (invited users
 *   accept their invite by signing in with SSO);
 * - an unknown email is created as a Service member only when the provider's
 *   auto-provision option is on (default off); otherwise it is refused.
 */
export function decideProvisioning(facts: ProvisioningFacts): SSOUserResolution {
  if (!facts.email) return reject('sso_email_missing', 'The identity provider did not send an email address');
  if (!facts.providerDomains) return reject('sso_provider_unknown', 'This identity provider is not configured');
  if (!emailDomainMatches(facts.email, facts.providerDomains)) {
    return reject('sso_domain_not_allowed', 'Your email domain is not allowed for this identity provider');
  }
  if (facts.existing) {
    if (facts.existing.status !== 'ACTIVE') return reject('account_disabled', 'Your OCSO account is disabled');
    return { action: 'link', userId: facts.existing.id, profile: 'preserve' };
  }
  if (!facts.autoProvision) return reject('sso_not_invited', 'You do not have an OCSO account yet. Ask an administrator to invite you.');
  return { action: 'continue' };
}

function reject(code: string, message: string): SSOUserResolution {
  return { action: 'reject', code, message };
}

/** Better Auth `sso({ resolveUser })`: runs on every SSO sign-in. */
export function ssoUserResolver(db: Db, audit: AuthAudit) {
  return async (input: SSOUserResolutionInput): Promise<SSOUserResolution> => {
    const email = (input.providerUser.email ?? '').trim().toLowerCase();
    const [provider] = await db
      .select({ domain: authSsoProviders.domain, autoProvision: authSsoProviders.autoProvision })
      .from(authSsoProviders)
      .where(eq(authSsoProviders.providerId, input.providerId))
      .limit(1);
    const [existing] = email
      ? await db.select({ id: users.id, status: users.status }).from(users).where(sql`lower(${users.email}) = ${email}`).limit(1)
      : [];
    const decision = decideProvisioning({ email, providerDomains: provider?.domain ?? null, autoProvision: provider?.autoProvision ?? false, existing: existing ?? null });
    if (decision.action === 'reject') {
      const entry = { action: 'auth.sso_rejected', summary: `SSO sign-in via ${input.providerId} refused: ${decision.code}` };
      if (existing) await audit.asUser(existing.id, {}, entry);
      else await audit.asSystem({}, { ...entry, targetType: 'sso_provider', targetId: input.providerId });
    }
    return decision;
  };
}
