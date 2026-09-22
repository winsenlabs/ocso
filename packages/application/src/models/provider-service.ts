import { asc, eq, sql } from 'drizzle-orm';
import { Permission } from '@ocso/auth';
import { DomainError, ErrorCategory, conflict, notFound, validation } from '@ocso/domain';
import { deploymentSettings, modelProfiles, modelProviders, uuidv7, type Db, type DbOrTx } from '@ocso/db';
import type { AdapterDeps, ProviderRegistry } from '@ocso/model-providers';
import type { SecretStore } from '@ocso/secrets';
import { recordAudit } from '../audit/audit.js';
import { bumpGeneration } from '../cache/generations.js';
import { emitEvent } from '../events/outbox.js';
import { nowOf, type ActorContext } from '../shared/context.js';
import { authorize, isForeignKeyViolation, isUniqueViolation } from './access.js';
import { describeSchemaFields, type ProviderFieldDescriptor } from './field-descriptors.js';
import type { ProviderInput, ProviderPatch, ProviderTestInput } from './inputs.js';
import { NO_MEDIA, resolveCredentials, validateProviderConfig, type ProviderRow } from './provider-config.js';
import { ProviderCredentialStore, type CredentialChange } from './provider-secrets.js';
import { runProviderTest, testErrorText, type ProviderTestResult } from './provider-test.js';
import { profilesByProvider, profilesUsingProvider } from './references.js';
import { EMPTY_USAGE_STATS, modelUsageStats } from './usage-stats.js';
import { toProviderView, type ProviderView } from './views.js';

export interface ModelAdminDeps {
  db: Db;
  secrets: SecretStore;
  registry: ProviderRegistry;
  /** Adapter dependencies for validation and test calls; media defaults to a resolver that rejects. */
  adapterDeps?: Partial<AdapterDeps> | undefined;
  now?: (() => Date) | undefined;
}

export interface ProviderKindView {
  kind: string;
  label: string;
  devOnly: boolean;
  settings: ProviderFieldDescriptor[];
  credentials: ProviderFieldDescriptor[];
}

/** Audit-safe snapshot: credential NAMES only (docs/15 §3). */
const auditSnapshot = (r: Pick<ProviderRow, 'kind' | 'name' | 'region' | 'residencyZone' | 'settings' | 'enabled' | 'maxConcurrency' | 'secretRefs'>) => ({
  kind: r.kind,
  name: r.name,
  region: r.region,
  residencyZone: r.residencyZone,
  settings: r.settings,
  enabled: r.enabled,
  maxConcurrency: r.maxConcurrency,
  credentialKeys: Object.keys(r.secretRefs),
});

/** Model provider administration (docs/06, ADR-006, ADR-012). Tech Admin owns writes. */
export class ProviderService {
  private readonly credentials: ProviderCredentialStore;
  private readonly adapterDeps: AdapterDeps;

  constructor(private readonly deps: ModelAdminDeps) {
    this.credentials = new ProviderCredentialStore(deps.secrets);
    this.adapterDeps = { media: deps.adapterDeps?.media ?? NO_MEDIA, ...(deps.adapterDeps?.fetch ? { fetch: deps.adapterDeps.fetch } : {}) };
  }

  kinds(actor: ActorContext): ProviderKindView[] {
    authorize(actor, Permission.PROVIDERS_READ);
    return this.deps.registry.list().map((d) => ({
      kind: d.kind,
      label: d.label,
      devOnly: d.devOnly,
      settings: describeSchemaFields(d.settingsSchema, { secret: false }),
      credentials: describeSchemaFields(d.credentialsSchema, { secret: true }),
    }));
  }

  async list(actor: ActorContext): Promise<ProviderView[]> {
    authorize(actor, Permission.PROVIDERS_READ);
    const rows = await this.deps.db.select().from(modelProviders).orderBy(asc(modelProviders.name));
    return this.views(rows);
  }

  async get(actor: ActorContext, id: string): Promise<ProviderView> {
    authorize(actor, Permission.PROVIDERS_READ);
    return this.view(await this.row(this.deps.db, id));
  }

  async create(actor: ActorContext, input: ProviderInput): Promise<ProviderView> {
    authorize(actor, Permission.PROVIDERS_MANAGE);
    const id = uuidv7();
    const source = { id, kind: input.kind, name: input.name, region: input.region, residencyZone: input.residencyZone, settings: input.settings };
    const settings = validateProviderConfig(this.deps.registry, source, input.credentials, this.adapterDeps);
    await this.assertNameFree(input.name, null);
    const change = await this.credentials.store(input.name, input.credentials);
    const row = await this.commit(change, async (tx) => {
      const [inserted] = await tx
        .insert(modelProviders)
        .values({ ...source, settings, secretRefs: change.refs, enabled: input.enabled, maxConcurrency: input.maxConcurrency })
        .returning();
      await recordAudit(tx, actor, {
        action: 'model_provider.create',
        targetType: 'model_provider',
        targetId: id,
        summary: `Added ${input.kind} provider ${input.name}`,
        after: auditSnapshot(inserted!),
      });
      await emitEvent(tx, actor, 'config.changed', { area: 'model_provider', entityId: id });
      return inserted!;
    });
    return this.view(row);
  }

  async update(actor: ActorContext, id: string, patch: ProviderPatch): Promise<ProviderView> {
    authorize(actor, Permission.PROVIDERS_MANAGE);
    const before = await this.row(this.deps.db, id);
    const next = {
      id,
      kind: before.kind,
      name: patch.name ?? before.name,
      region: patch.region !== undefined ? patch.region : before.region,
      residencyZone: patch.residencyZone !== undefined ? patch.residencyZone : before.residencyZone,
      settings: patch.settings ?? before.settings,
    };
    let settings = before.settings;
    if (patch.settings !== undefined || patch.credentials !== undefined || next.region !== before.region) {
      settings = validateProviderConfig(this.deps.registry, next, await this.mergedCredentials(before, patch.credentials ?? {}), this.adapterDeps);
    }
    if (patch.enabled === true && !this.deps.registry.get(before.kind)) {
      throw validation('provider_kind_not_available', `Provider ${before.kind} is not available in this deployment`, { kind: before.kind });
    }
    if (next.name.toLowerCase() !== before.name.toLowerCase()) await this.assertNameFree(next.name, id);
    const change = patch.credentials ? await this.credentials.apply(next.name, before.secretRefs, patch.credentials) : null;
    const row = await this.commit(change, async (tx) => {
      const [updated] = await tx
        .update(modelProviders)
        .set({
          name: next.name,
          region: next.region,
          residencyZone: next.residencyZone,
          settings,
          secretRefs: change?.refs ?? before.secretRefs,
          ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
          ...(patch.maxConcurrency !== undefined ? { maxConcurrency: patch.maxConcurrency } : {}),
          updatedAt: new Date(),
        })
        .where(eq(modelProviders.id, id))
        .returning();
      const { credentials: _values, ...fields } = patch;
      await recordAudit(tx, actor, {
        action: 'model_provider.update',
        targetType: 'model_provider',
        targetId: id,
        summary: `Updated provider ${before.name}${change?.changedKeys.length ? ` (credentials changed: ${change.changedKeys.join(', ')})` : ''}`,
        before: auditSnapshot(before),
        after: { ...fields, ...(change ? { changedCredentialKeys: change.changedKeys } : {}) },
      });
      await emitEvent(tx, actor, 'config.changed', { area: 'model_provider', entityId: id });
      await this.bumpProfiles(tx, actor, id);
      return updated!;
    });
    if (change) await this.credentials.discard(change.released);
    return this.view(row);
  }

  setEnabled(actor: ActorContext, id: string, enabled: boolean): Promise<ProviderView> {
    return this.update(actor, id, { enabled });
  }

  async delete(actor: ActorContext, id: string): Promise<void> {
    authorize(actor, Permission.PROVIDERS_MANAGE);
    const removed = await this.deps.db
      .transaction(async (tx) => {
        const [row] = await tx.select().from(modelProviders).where(eq(modelProviders.id, id)).for('update');
        if (!row) throw notFound('model_provider', id);
        const users = await profilesUsingProvider(tx, id);
        if (users.length) {
          throw new DomainError(ErrorCategory.CONFLICT, 'model_provider_in_use', `${row.name} is used by model profiles; reassign them first`, {
            profiles: users.map((p) => p.name),
          });
        }
        await tx.delete(modelProviders).where(eq(modelProviders.id, id));
        await recordAudit(tx, actor, {
          action: 'model_provider.delete',
          targetType: 'model_provider',
          targetId: id,
          summary: `Removed provider ${row.name}`,
          before: auditSnapshot(row),
        });
        await emitEvent(tx, actor, 'config.changed', { area: 'model_provider', entityId: id });
        return row;
      })
      .catch((error: unknown) => {
        // A profile created concurrently still holds the FK.
        if (isForeignKeyViolation(error)) throw conflict('model_provider_in_use', 'The provider is used by a model profile');
        throw error;
      });
    await this.credentials.discard(Object.values(removed.secretRefs));
  }

  async test(actor: ActorContext, id: string, input: ProviderTestInput = {}): Promise<ProviderTestResult> {
    authorize(actor, Permission.PROVIDERS_MANAGE);
    const row = await this.row(this.deps.db, id);
    const model = input.model ?? (await this.defaultTestModel(row));
    const result = await runProviderTest({ registry: this.deps.registry, secrets: this.deps.secrets, adapterDeps: this.adapterDeps }, row, model);
    await this.deps.db.transaction(async (tx) => {
      // Health fields only: updatedAt marks configuration changes (adapter cache key), so it is left alone.
      await tx
        .update(modelProviders)
        .set({
          status: result.status === 'UNCONFIGURED' ? 'DOWN' : result.status,
          lastHealthAt: nowOf(this.deps),
          lastHealthLatencyMs: result.health.latencyMs,
          lastError: testErrorText(result),
        })
        .where(eq(modelProviders.id, id));
      await recordAudit(tx, actor, {
        action: 'model_provider.test',
        targetType: 'model_provider',
        targetId: id,
        summary: `Tested ${row.name}: ${result.status}`,
        after: { status: result.status, model: result.model, latencyMs: result.health.latencyMs },
      });
      await emitEvent(tx, actor, 'config.changed', { area: 'model_provider_health', entityId: id });
    });
    return result;
  }

  private async defaultTestModel(row: ProviderRow): Promise<string | null> {
    const configured = row.settings['healthModel'];
    if (typeof configured === 'string' && configured) return configured;
    const [profile] = await this.deps.db
      .select({ model: modelProfiles.model })
      .from(modelProfiles)
      .where(eq(modelProfiles.providerId, row.id))
      .orderBy(asc(modelProfiles.name))
      .limit(1);
    return profile?.model ?? null;
  }

  private async mergedCredentials(row: ProviderRow, patch: Readonly<Record<string, string | null>>): Promise<Record<string, string>> {
    const merged = await resolveCredentials(this.deps.secrets, row.secretRefs);
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete merged[key];
      else merged[key] = value;
    }
    return merged;
  }

  private async bumpProfiles(tx: DbOrTx, actor: ActorContext, providerId: string): Promise<void> {
    for (const profile of await profilesUsingProvider(tx, providerId)) {
      await bumpGeneration(tx, actor.correlationId, `profile:${profile.id}`, 'model_config_changed');
    }
  }

  /** Run the row write; on failure, remove secrets this change created (rotations cannot be undone). */
  private async commit<T>(change: CredentialChange | null, write: (tx: DbOrTx) => Promise<T>): Promise<T> {
    try {
      return await this.deps.db.transaction(write);
    } catch (error) {
      if (change) await this.credentials.discard(change.created);
      if (isUniqueViolation(error)) throw conflict('model_provider_name_taken', 'A provider with this name already exists');
      throw error;
    }
  }

  private async assertNameFree(name: string, exceptId: string | null): Promise<void> {
    const [clash] = await this.deps.db
      .select({ id: modelProviders.id })
      .from(modelProviders)
      .where(sql`lower(${modelProviders.name}) = lower(${name})`);
    if (clash && clash.id !== exceptId) throw conflict('model_provider_name_taken', `A provider named ${name} already exists`);
  }

  private async row(db: DbOrTx, id: string): Promise<ProviderRow> {
    const [row] = await db.select().from(modelProviders).where(eq(modelProviders.id, id));
    if (!row) throw notFound('model_provider', id);
    return row;
  }

  private async view(row: ProviderRow): Promise<ProviderView> {
    const [view] = await this.views([row]);
    return view!;
  }

  private async views(rows: ProviderRow[]): Promise<ProviderView[]> {
    const ids = rows.map((r) => r.id);
    const [[settings], profiles, stats] = await Promise.all([
      this.deps.db.select().from(deploymentSettings).where(eq(deploymentSettings.id, 1)),
      profilesByProvider(this.deps.db, ids),
      modelUsageStats(this.deps.db, 'provider', ids, nowOf(this.deps)),
    ]);
    return rows.map((row) =>
      toProviderView(row, { registry: this.deps.registry, settings, profiles: profiles.get(row.id) ?? [], stats: stats.get(row.id) ?? EMPTY_USAGE_STATS }),
    );
  }
}
