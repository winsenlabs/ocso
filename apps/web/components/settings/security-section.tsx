import { Permission, ROLES, ROLE_LABELS } from '@ocso/auth';
import { AlertBanner } from '@/components/ui/alert-banner';
import { SecHead } from '@/components/ui/sec-head';
import { getAuthPolicy, listSsoProviders } from '@/lib/api/auth-settings';
import { describeApiError } from '@/lib/api/errors';
import { hasPermission, requireSession } from '@/lib/session';
import { MfaPolicyForm } from './mfa-policy-form';
import { SsoProviders } from './sso-providers';

/**
 * Sign-in security for the Tech admin (ADR-025): which roles must use
 * a second factor, and the SSO identity providers bound to email domains.
 */
export async function SecuritySection() {
  const session = await requireSession();
  if (!hasPermission(session, Permission.DEPLOYMENT_SETTINGS_MANAGE)) return null;
  let error: string | null = null;
  const [policy, providers] = await Promise.all([
    getAuthPolicy().catch((err: unknown) => ((error = describeApiError(err)), null)),
    listSsoProviders().catch((err: unknown) => ((error = describeApiError(err)), [])),
  ]);
  return (
    <div className="row2" style={{ marginTop: 24 }}>
      <div>
        <SecHead title="Sign-in security" desc="two-factor policy · Tech admin" />
        {error ? <AlertBanner tone="error">{error}</AlertBanner> : null}
        {policy ? <MfaPolicyForm roles={ROLES.map((r) => ({ value: r, label: ROLE_LABELS[r] }))} selected={policy.requireMfaRoles} /> : null}
      </div>
      <div>
        <SecHead title="Single sign-on" count={providers.length} desc="OIDC or SAML 2.0 · bound to email domains" />
        <SsoProviders providers={providers} />
      </div>
    </div>
  );
}
