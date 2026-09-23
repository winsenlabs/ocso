import { eq, sql } from 'drizzle-orm';
import { Permission } from '@ocso/auth';
import { isDomainError } from '@ocso/domain';
import { modelProviders, type DbOrTx } from '@ocso/db';
import type { AdapterDeps, ProviderRegistry } from '@ocso/model-providers';
import type { SecretStore } from '@ocso/secrets';
import { z } from 'zod';
import { recordAudit } from '../audit/audit.js';
import { bumpGeneration } from '../cache/generations.js';
import { emitEvent } from '../events/outbox.js';
import type { ApprovalDescriptor, ApprovalProblem, ProposalRow } from '../approvals/contract.js';
import { credentialView, platformRequiresApproval, platformTitle, platformVisible, StoredCredentials } from '../settings/platform-approvals.js';
import { claimSecrets, releaseSecrets, unstagedRefProblems } from '../settings/secret-refs.js';
import { ProviderPatch } from './inputs.js';
import { NO_MEDIA, resolveCredentials, validateProviderConfig, type ProviderRow } from './provider-config.js';
import { profilesUsingProvider } from './references.js';

/**
 * Model providers under maker–checker (PM/research/11 §4, approvals.check.platform). A provider is created
 * disabled — a draft: nothing can call it (the runtime and agent go-live refuse disabled providers) and it is
 * freely editable. Enabling is ACTIVATE (the first time and when resuming); disabling is a stop action,
 * immediate and never gated. Once approved, every change is an UPDATE proposal; new credential values are
 * stored as new secrets at submit and only their refs travel. DELETE is always a proposal.
 */

export const ProviderChange = ProviderPatch.omit({ enabled: true, credentials: true })
  .extend({
    /** New or replaced credentials, as secret refs created at submit. */
    credentials: StoredCredentials.optional(),
    /** Credential names to remove. */
    removeCredentials: z.array(z.string().min(1).max(64)).max(20).optional(),
  })
  .strict();
export type ProviderChange = z.infer<typeof ProviderChange>;

export interface ProviderApprovalDeps {
  secrets?: SecretStore | undefined;
  providers?: ProviderRegistry | undefined;
}

async function load(tx: DbOrTx, id: string): Promise<ProviderRow | null> {
  const [row] = await tx.select().from(modelProviders).where(eq(modelProviders.id, id));
  return row ?? null;
}

/** The refs the provider holds once the change applies. */
export function providerRefsAfter(current: Readonly<Record<string, string>>, change: ProviderChange): Record<string, string> {
  const refs: Record<string, string> = { ...current };
  for (const field of change.removeCredentials ?? []) delete refs[field];
  for (const c of change.credentials ?? []) refs[c.field] = c.ref;
  return refs;
}

function projectRow(row: ProviderRow, change?: ProviderChange): Record<string, unknown> {
  return {
    name: change?.name ?? row.name,
    kind: row.kind,
    region: change?.region !== undefined ? change.region : row.region,
    residencyZone: change?.residencyZone !== undefined ? change.residencyZone : row.residencyZone,
    settings: change?.settings ?? row.settings,
    maxConcurrency: change?.maxConcurrency ?? row.maxConcurrency,
    enabled: row.enabled,
    credentials: credentialView(Object.keys(row.secretRefs), { replaced: change?.credentials?.map((c) => c.field), removed: change?.removeCredentials }),
  };
}

async function configProblems(deps: ProviderApprovalDeps, row: ProviderRow, change: ProviderChange): Promise<ApprovalProblem[]> {
  if (!deps.secrets || !deps.providers) return [{ code: 'provider_validation_unavailable', message: 'Provider configuration cannot be checked in this process.' }];
  try {
    const credentials = await resolveCredentials(deps.secrets, providerRefsAfter(row.secretRefs, change));
    const source = { id: row.id, kind: row.kind, name: change.name ?? row.name, region: change.region !== undefined ? change.region : row.region, residencyZone: change.residencyZone !== undefined ? change.residencyZone : row.residencyZone, settings: change.settings ?? row.settings };
    validateProviderConfig(deps.providers, source, credentials, { media: NO_MEDIA } satisfies Partial<AdapterDeps> as AdapterDeps);
    return [];
  } catch (err) {
    if (isDomainError(err)) return [{ code: err.code, message: err.message }];
    return [{ code: 'provider_configuration_invalid', message: 'The provider configuration could not be checked.' }];
  }
}

export function providerApproval(deps: ProviderApprovalDeps = {}): ApprovalDescriptor {
  return {
    kind: 'model_provider',
    label: 'Model provider',
    actions: ['ACTIVATE', 'UPDATE', 'DELETE'],
    makePermission: () => Permission.PROVIDERS_MANAGE,
    checkPermission: Permission.APPROVALS_CHECK_PLATFORM,
    payload: ProviderChange,
    // Disabling is a stop action and must not void an open proposal.
    hashExclude: ['enabled'],

    async project(tx, id) {
      const row = await load(tx, id);
      return row ? projectRow(row) : null;
    },
    async projectAfter(tx, p) {
      const row = await load(tx, p.objectId);
      if (!row || p.action === 'DELETE') return null;
      if (p.action === 'ACTIVATE') return { ...projectRow(row), enabled: true };
      return projectRow(row, p.payload as ProviderChange);
    },
    teamIds: async () => [],
    dependencies: async () => [],
    assertVisible: platformVisible(Permission.PROVIDERS_READ),
    requiresApproval: platformRequiresApproval('model_provider'),
    async validate(tx, p) {
      const row = await load(tx, p.objectId);
      if (!row) return [{ code: 'object_missing', message: 'The provider no longer exists.' }];
      if (p.action === 'DELETE') {
        const users = await profilesUsingProvider(tx, row.id);
        return users.length ? [{ code: 'model_provider_in_use', message: `${row.name} is used by model profiles (${users.map((u) => u.name).join(', ')}); reassign them first.` }] : [];
      }
      if (p.action === 'ACTIVATE') {
        if (row.enabled) return [{ code: 'already_enabled', message: 'The provider is already enabled.' }];
        if (deps.providers && !deps.providers.get(row.kind)) return [{ code: 'provider_kind_not_available', message: `Provider ${row.kind} is not available in this deployment.` }];
        return configProblems(deps, row, {});
      }
      const change = p.payload as ProviderChange;
      const unstaged = await unstagedRefProblems(tx, p, (change.credentials ?? []).map((c) => c.ref));
      if (unstaged.length) return unstaged;
      const problems = await configProblems(deps, row, change);
      if (change.name && change.name.toLowerCase() !== row.name.toLowerCase()) {
        const [clash] = await tx.select({ id: modelProviders.id }).from(modelProviders).where(sql`lower(${modelProviders.name}) = lower(${change.name})`);
        if (clash && clash.id !== row.id) problems.push({ code: 'model_provider_name_taken', message: `A provider named ${change.name} already exists.` });
      }
      return problems;
    },
    async activate(tx, actor, p) {
      const row = (await load(tx, p.objectId))!;
      if (p.action === 'DELETE') {
        await tx.delete(modelProviders).where(eq(modelProviders.id, row.id));
        await recordAudit(tx, actor, { action: 'model_provider.delete', targetType: 'model_provider', targetId: row.id, summary: `Removed provider ${row.name}`, before: { name: row.name, kind: row.kind, credentialKeys: Object.keys(row.secretRefs) } });
        await emitEvent(tx, actor, 'config.changed', { area: 'model_provider', entityId: row.id });
        await releaseSecrets(tx, { kind: 'model_provider', objectId: row.id }, Object.values(row.secretRefs));
        return { kind: 'DONE' };
      }
      if (p.action === 'ACTIVATE') {
        await tx.update(modelProviders).set({ enabled: true, updatedAt: new Date() }).where(eq(modelProviders.id, row.id));
        await recordAudit(tx, actor, { action: 'model_provider.enable', targetType: 'model_provider', targetId: row.id, summary: `Enabled provider ${row.name}`, before: { enabled: false }, after: { enabled: true } });
      } else {
        const change = p.payload as ProviderChange;
        const refs = providerRefsAfter(row.secretRefs, change);
        const settings = change.settings !== undefined && deps.providers ? (deps.providers.get(row.kind)?.settingsSchema.parse(change.settings) as Record<string, unknown>) : (change.settings ?? row.settings);
        const { credentials, removeCredentials, ...fields } = change;
        await tx
          .update(modelProviders)
          .set({ ...fields, settings, secretRefs: refs, updatedAt: new Date() })
          .where(eq(modelProviders.id, row.id));
        const changedKeys = [...(credentials ?? []).map((c) => c.field), ...(removeCredentials ?? [])];
        await recordAudit(tx, actor, {
          action: 'model_provider.update',
          targetType: 'model_provider',
          targetId: row.id,
          summary: `Updated provider ${row.name}${changedKeys.length ? ` (credentials changed: ${changedKeys.join(', ')})` : ''}`,
          before: { name: row.name, region: row.region, residencyZone: row.residencyZone, settings: row.settings, maxConcurrency: row.maxConcurrency, credentialKeys: Object.keys(row.secretRefs) },
          after: { ...fields, ...(changedKeys.length ? { changedCredentialKeys: changedKeys } : {}) },
        });
        const released = Object.entries(row.secretRefs).filter(([field, ref]) => refs[field] !== ref).map(([, ref]) => ref);
        await claimSecrets(tx, (credentials ?? []).map((c) => c.ref));
        await releaseSecrets(tx, { kind: 'model_provider', objectId: row.id }, released);
      }
      await emitEvent(tx, actor, 'config.changed', { area: 'model_provider', entityId: row.id });
      for (const profile of await profilesUsingProvider(tx, row.id)) await bumpGeneration(tx, actor.correlationId, `profile:${profile.id}`, 'model_config_changed');
      return { kind: 'DONE' };
    },
    async liveObjects(tx) {
      return (await tx.select({ id: modelProviders.id }).from(modelProviders).where(eq(modelProviders.enabled, true))).map((r) => r.id);
    },
    title: (p: ProposalRow, before) => platformTitle(p, before, { noun: 'model provider', activateVerb: 'Enable' }),
  };
}
