import { eq } from 'drizzle-orm';
import { Permission } from '@ocso/auth';
import { authAccounts, authSsoProviders, type DbOrTx } from '@ocso/db';
import { recordAudit } from '../../audit/audit.js';
import type { ApprovalDescriptor, ApprovalProblem, ProposalRow } from '../../approvals/contract.js';
import { platformRequiresApproval, platformTitle, platformVisible } from '../../settings/platform-approvals.js';
import { SsoProviderPatch, toSsoProviderView } from './sso-types.js';

/**
 * SSO identity providers under maker–checker (PM/research/11 §4, approvals.check.platform). The object id is
 * the provider row's uuid. A newly registered provider is a DRAFT: sign-in through it is refused
 * (sso-resolver.ts) and it is not offered on the sign-in page. ACTIVATE makes it usable (and resumes a
 * disabled one); disabling is a stop action. Once approved, name, domains and auto-provisioning change by
 * UPDATE proposal (endpoints and client secrets are replaced by delete and re-add, as before). DELETE is
 * always a proposal. Client secrets live in Better Auth's row and are never projected.
 */

type SsoRow = typeof authSsoProviders.$inferSelect;

async function load(tx: DbOrTx, id: string): Promise<SsoRow | null> {
  const [row] = await tx.select().from(authSsoProviders).where(eq(authSsoProviders.id, id));
  return row ?? null;
}

function projectRow(row: SsoRow, publicUrl: string, patch?: SsoProviderPatch): Record<string, unknown> {
  const view = toSsoProviderView(row, publicUrl);
  return {
    name: patch?.name ?? view.name,
    providerId: view.providerId,
    type: view.type,
    issuer: view.issuer,
    domains: [...(patch?.domains ?? view.domains)].sort(),
    autoProvision: patch?.autoProvision ?? view.autoProvision,
    status: row.status,
    oidc: view.oidc,
    saml: view.saml ? { entryPoint: view.saml.entryPoint, certificateFingerprint: view.saml.certificateFingerprint, certificateExpiresAt: view.saml.certificateExpiresAt } : null,
  };
}

export function ssoProviderApproval(deps: { publicUrl?: string | undefined } = {}): ApprovalDescriptor {
  const publicUrl = deps.publicUrl ?? 'http://localhost';
  return {
    kind: 'sso_provider',
    label: 'SSO provider',
    actions: ['ACTIVATE', 'UPDATE', 'DELETE'],
    makePermission: () => Permission.DEPLOYMENT_SETTINGS_MANAGE,
    checkPermission: Permission.APPROVALS_CHECK_PLATFORM,
    payload: SsoProviderPatch.strict(),
    hashExclude: ['status'],

    async project(tx, id) {
      const row = await load(tx, id);
      return row ? projectRow(row, publicUrl) : null;
    },
    async projectAfter(tx, p) {
      const row = await load(tx, p.objectId);
      if (!row || p.action === 'DELETE') return null;
      if (p.action === 'ACTIVATE') return { ...projectRow(row, publicUrl), status: 'ACTIVE' };
      return projectRow(row, publicUrl, p.payload as SsoProviderPatch);
    },
    teamIds: async () => [],
    dependencies: async () => [],
    assertVisible: platformVisible(Permission.DEPLOYMENT_SETTINGS_MANAGE),
    requiresApproval: platformRequiresApproval('sso_provider'),
    async validate(tx, p) {
      const row = await load(tx, p.objectId);
      if (!row) return [{ code: 'object_missing', message: 'The SSO provider no longer exists.' }];
      const problems: ApprovalProblem[] = [];
      if (p.action === 'ACTIVATE' && row.status === 'ACTIVE') problems.push({ code: 'already_active', message: 'The SSO provider is already active.' });
      return problems;
    },
    async activate(tx, actor, p) {
      const row = (await load(tx, p.objectId))!;
      if (p.action === 'DELETE') {
        // As Better Auth's own delete does: the accounts linked through this provider go with it.
        await tx.delete(authAccounts).where(eq(authAccounts.providerId, row.providerId));
        await tx.delete(authSsoProviders).where(eq(authSsoProviders.id, row.id));
        await recordAudit(tx, actor, { action: 'sso.provider_delete', targetType: 'sso_provider', targetId: row.providerId, summary: `Removed SSO provider ${row.name}`, before: projectRow(row, publicUrl) });
      } else if (p.action === 'ACTIVATE') {
        await tx.update(authSsoProviders).set({ status: 'ACTIVE', updatedAt: new Date() }).where(eq(authSsoProviders.id, row.id));
        await recordAudit(tx, actor, { action: 'sso.provider_activate', targetType: 'sso_provider', targetId: row.providerId, summary: `${row.status === 'DISABLED' ? 'Re-enabled' : 'Activated'} SSO provider ${row.name}`, before: { status: row.status }, after: { status: 'ACTIVE' } });
      } else {
        const patch = p.payload as SsoProviderPatch;
        await tx
          .update(authSsoProviders)
          .set({
            ...(patch.name !== undefined ? { name: patch.name } : {}),
            ...(patch.domains !== undefined ? { domain: patch.domains.join(',') } : {}),
            ...(patch.autoProvision !== undefined ? { autoProvision: patch.autoProvision } : {}),
            updatedAt: new Date(),
          })
          .where(eq(authSsoProviders.id, row.id));
        await recordAudit(tx, actor, { action: 'sso.provider_update', targetType: 'sso_provider', targetId: row.providerId, summary: `Updated SSO provider ${row.name}`, before: projectRow(row, publicUrl), after: patch });
      }
      return { kind: 'DONE' };
    },
    async liveObjects(tx) {
      return (await tx.select({ id: authSsoProviders.id }).from(authSsoProviders).where(eq(authSsoProviders.status, 'ACTIVE'))).map((r) => r.id);
    },
    title: (p: ProposalRow, before) => platformTitle(p, before, { noun: 'SSO provider', resumed: before?.['status'] === 'DISABLED' }),
  };
}
