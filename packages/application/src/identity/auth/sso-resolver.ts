import { eq, sql } from 'drizzle-orm';
import type { SSOUserResolution, SSOUserResolutionInput } from '@better-auth/sso';
import type { UserStatus } from '@ocso/auth';
import { authSsoProviders, users, uuidv7, type Db } from '@ocso/db';
import type { AuthAudit } from './audit.js';
import { emailDomainMatches } from './request.js';

/** What OCSO knows about a provider and a local user, for the provisioning decision. */
export interface ProvisioningFacts {
  email: string;
  providerDomains: string | null;
  autoProvision: boolean;
  existing: { id: string; status: UserStatus } | null;
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
    if (facts.existing.status === 'PENDING_APPROVAL') return reject('account_pending_approval', 'Your OCSO account is waiting for approval');
    if (facts.existing.status !== 'ACTIVE') return reject('account_disabled', 'Your OCSO account is disabled');
    return { action: 'link', userId: facts.existing.id, profile: 'preserve' };
  }
  if (!facts.autoProvision) return reject('sso_not_invited', 'You do not have an OCSO account yet. Ask an administrator to invite you.');
  return { action: 'continue' };
}

function reject(code: string, message: string): SSOUserResolution {
  return { action: 'reject', code, message };
}

/**
 * Auto-provisioning on a governed deployment (PM/research/11 §2.7: creating a
 * user is an increase). The new Service member is written PENDING_APPROVAL
 * here — outside Better Auth's sign-in transaction, which would roll it back
 * with the refused session — audited, and the sign-in is refused with
 * account_pending_approval. Once their creation is approved, the next SSO
 * sign-in links them like any existing user.
 */
async function provisionPending(db: Db, audit: AuthAudit, input: SSOUserResolutionInput, email: string): Promise<SSOUserResolution> {
  const id = uuidv7();
  const name = (typeof input.providerUser.name === 'string' && input.providerUser.name.trim()) || email.split('@')[0] || email;
  const created = await db
    .insert(users)
    .values({ id, email, name: name.slice(0, 200), role: 'SERVICE', status: 'PENDING_APPROVAL', emailVerified: true })
    .onConflictDoNothing()
    .returning({ id: users.id });
  if (created.length) {
    await audit.asSystem({}, {
      action: 'user.create',
      targetType: 'user',
      targetId: id,
      summary: `Created SERVICE ${email} on first SSO sign-in via ${input.providerId} (auto-provisioning), pending approval`,
      after: { role: 'SERVICE', status: 'PENDING_APPROVAL', provisionedBy: 'sso', providerId: input.providerId },
    });
  }
  return reject('account_pending_approval', 'Your OCSO account was created and is waiting for approval');
}

/**
 * Better Auth `sso({ resolveUser })`: runs on every SSO sign-in. Unless the
 * deployment skips access approval (development), auto-provisioned users start
 * pending approval (provisionPending).
 */
export function ssoUserResolver(db: Db, audit: AuthAudit, options: { skipAccessApproval?: boolean | undefined } = {}) {
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
    if (decision.action === 'continue' && !options.skipAccessApproval) return provisionPending(db, audit, input, email);
    if (decision.action === 'reject') {
      const entry = { action: 'auth.sso_rejected', summary: `SSO sign-in via ${input.providerId} refused: ${decision.code}` };
      if (existing) await audit.asUser(existing.id, {}, entry);
      else await audit.asSystem({}, { ...entry, targetType: 'sso_provider', targetId: input.providerId });
    }
    return decision;
  };
}
