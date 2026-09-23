import { asc, eq, sql } from 'drizzle-orm';
import { Permission, can } from '@ocso/auth';
import { DomainError, ErrorCategory, conflict, notFound, policyDenied } from '@ocso/domain';
import { modelProfiles, modelProviders, uuidv7, type Db, type DbOrTx } from '@ocso/db';
import type { ProviderRegistry } from '@ocso/model-providers';
import { recordAudit } from '../audit/audit.js';
import { bumpGeneration } from '../cache/generations.js';
import { emitEvent } from '../events/outbox.js';
import { nowOf, type ActorContext } from '../shared/context.js';
import { authorize, authorizeAny, isForeignKeyViolation, isUniqueViolation } from './access.js';
import { baseModelFor, ensureCatalogPrices, isPricedKind, type PriceCheck, type PriceTarget } from './catalog/catalog-prices.js';
import type { ModelCatalogService } from './catalog/catalog-service.js';
import type { ProfileInput, ProfilePatch } from './inputs.js';
import { checkProfileTargets, modelFacts, type ProfilePolicyCheck } from './model-policy.js';
import { agentsByProfile } from './references.js';
import { EMPTY_USAGE_STATS, modelUsageStats } from './usage-stats.js';
import { toProfileView, type ProfileRow, type ProfileView } from './views.js';

export interface ProfileServiceDeps {
  db: Db;
  registry: ProviderRegistry;
  /** When given, saving a profile pre-fills missing price rows from the model catalog (ADR-027). */
  catalog?: ModelCatalogService | undefined;
  now?: (() => Date) | undefined;
}

/** A saved profile plus the policy check it passed (warnings for skipped fallbacks). */
export interface ProfileSaveResult extends ProfileView {
  policy: ProfilePolicyCheck;
  /** Price status of every target after the save (added = pre-filled from the catalog just now). */
  prices: PriceCheck[];
}

type ProfileFields = Omit<ProfileRow, 'id' | 'configVersion' | 'createdAt' | 'updatedAt'>;

const FIELD_KEYS = [
  'name',
  'description',
  'providerId',
  'model',
  'temperature',
  'maxOutputTokens',
  'reasoning',
  'timeoutMs',
  'retries',
  'retryBackoffMs',
  'cachePolicy',
  'cacheTtl',
  'fallbacks',
  'requiredCapabilities',
] as const satisfies ReadonlyArray<keyof ProfileFields>;

const fieldsOf = (row: ProfileFields): ProfileFields => Object.fromEntries(FIELD_KEYS.map((k) => [k, row[k]])) as ProfileFields;

/** Stored capability requirements hold only explicit booleans. */
const cleanCapabilities = (caps: Readonly<Record<string, boolean | undefined>>): Record<string, boolean> =>
  Object.fromEntries(Object.entries(caps).filter((e): e is [string, boolean] => e[1] !== undefined));

function definedFields(patch: ProfilePatch): Partial<ProfileFields> {
  const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as Partial<ProfileFields>;
  if (patch.requiredCapabilities) defined.requiredCapabilities = cleanCapabilities(patch.requiredCapabilities);
  return defined;
}

/**
 * Logical model profiles (docs/06 §2): agents reference these, never provider
 * model ids. Saves are checked against the deployment model policy with the
 * same planner the runtime gateway uses; a non-permitted primary is rejected.
 */
export class ProfileService {
  constructor(private readonly deps: ProfileServiceDeps) {}

  /** Tech admins and Leads (provider read) and anyone who can read agents (to pick a profile). */
  async list(actor: ActorContext): Promise<ProfileView[]> {
    const principal = authorizeAny(actor, [Permission.PROVIDERS_READ, Permission.AGENTS_READ]);
    const rows = await this.deps.db.select().from(modelProfiles).orderBy(asc(modelProfiles.name));
    return this.views(rows, can(principal, Permission.PROVIDERS_READ));
  }

  async get(actor: ActorContext, id: string): Promise<ProfileView> {
    const principal = authorizeAny(actor, [Permission.PROVIDERS_READ, Permission.AGENTS_READ]);
    const [view] = await this.views([await this.row(this.deps.db, id)], can(principal, Permission.PROVIDERS_READ));
    return view!;
  }

  /** Dry run: the policy check a save would perform, without saving (the "residency check" box). */
  async validate(actor: ActorContext, input: ProfileInput): Promise<ProfilePolicyCheck> {
    authorize(actor, Permission.MODEL_PROFILES_MANAGE);
    const target = { ...input, requiredCapabilities: cleanCapabilities(input.requiredCapabilities) };
    return checkProfileTargets(this.deps.db, this.deps.registry, target, nowOf(this.deps));
  }

  async create(actor: ActorContext, input: ProfileInput): Promise<ProfileSaveResult> {
    authorize(actor, Permission.MODEL_PROFILES_MANAGE);
    const id = uuidv7();
    const fields = fieldsOf({ ...input, requiredCapabilities: cleanCapabilities(input.requiredCapabilities) });
    return this.save(async (tx) => {
      await this.assertNameFree(tx, fields.name, null);
      const policy = await this.permitted(tx, fields);
      const [row] = await tx
        .insert(modelProfiles)
        .values({ id, ...fields })
        .returning();
      await recordAudit(tx, actor, {
        action: 'model_profile.create',
        targetType: 'model_profile',
        targetId: id,
        summary: `Created model profile ${input.name} (${policy.primary.providerName} · ${input.model})`,
        after: input,
      });
      await emitEvent(tx, actor, 'config.changed', { area: 'model_profile', entityId: id });
      return { row: row!, policy };
    }, actor);
  }

  async update(actor: ActorContext, id: string, patch: ProfilePatch): Promise<ProfileSaveResult> {
    authorize(actor, Permission.MODEL_PROFILES_MANAGE);
    return this.save(async (tx) => {
      const before = await this.row(tx, id, true);
      const defined = definedFields(patch);
      const merged = fieldsOf({ ...before, ...defined });
      if (merged.name !== before.name) await this.assertNameFree(tx, merged.name, id);
      const policy = await this.permitted(tx, merged);
      const changed = FIELD_KEYS.filter((k) => JSON.stringify(merged[k]) !== JSON.stringify(before[k]));
      if (!changed.length) return { row: before, policy };
      const [row] = await tx
        .update(modelProfiles)
        .set({ ...merged, configVersion: sql`${modelProfiles.configVersion} + 1`, updatedAt: new Date() })
        .where(eq(modelProfiles.id, id))
        .returning();
      await recordAudit(tx, actor, {
        action: 'model_profile.update',
        targetType: 'model_profile',
        targetId: id,
        summary: `Updated model profile ${before.name}: ${changed.join(', ')}`,
        before: fieldsOf(before),
        after: defined,
      });
      await emitEvent(tx, actor, 'config.changed', { area: 'model_profile', entityId: id });
      await bumpGeneration(tx, actor.correlationId, `profile:${id}`, 'model_config_changed');
      return { row: row!, policy };
    }, actor);
  }

  async delete(actor: ActorContext, id: string): Promise<void> {
    authorize(actor, Permission.MODEL_PROFILES_MANAGE);
    try {
      await this.deps.db.transaction(async (tx) => {
        const row = await this.row(tx, id, true);
        const agents = (await agentsByProfile(tx, [id])).get(id) ?? [];
        if (agents.length) {
          throw new DomainError(ErrorCategory.CONFLICT, 'model_profile_in_use', `${row.name} is used by virtual agents; reassign them first`, {
            agents: [...new Set(agents.map((a) => a.name))],
          });
        }
        await tx.delete(modelProfiles).where(eq(modelProfiles.id, id));
        await recordAudit(tx, actor, {
          action: 'model_profile.delete',
          targetType: 'model_profile',
          targetId: id,
          summary: `Deleted model profile ${row.name}`,
          before: fieldsOf(row),
        });
        await emitEvent(tx, actor, 'config.changed', { area: 'model_profile', entityId: id });
      });
    } catch (error) {
      // An agent assigned concurrently still holds the FK.
      if (isForeignKeyViolation(error)) throw conflict('model_profile_in_use', 'The profile is used by a virtual agent');
      throw error;
    }
  }

  /** Reject a save whose primary target the deployment policy does not permit. */
  private async permitted(tx: DbOrTx, target: ProfileFields): Promise<ProfilePolicyCheck> {
    const policy = await checkProfileTargets(tx, this.deps.registry, target, nowOf(this.deps));
    if (!policy.ok) {
      throw policyDenied('model_target_not_permitted', policy.message, {
        providerId: policy.primary.providerId,
        reason: policy.primary.reason,
      });
    }
    return policy;
  }

  private async save(write: (tx: DbOrTx) => Promise<{ row: ProfileRow; policy: ProfilePolicyCheck }>, actor?: ActorContext): Promise<ProfileSaveResult> {
    let saved: { row: ProfileRow; policy: ProfilePolicyCheck };
    try {
      saved = await this.deps.db.transaction(write);
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict('model_profile_name_taken', 'A model profile with this name already exists');
      throw error;
    }
    const [view] = await this.views([saved.row], true);
    return { ...view!, policy: saved.policy, prices: actor ? await this.prices(actor, saved.row) : [] };
  }

  /**
   * Price every target from the catalog when no row prices it yet. Best
   * effort after the commit: a catalog problem never fails the save; such
   * targets are reported as missing. Targets of kinds that are never priced
   * (dev-only, or not registered here) are not reported.
   */
  private async prices(actor: ActorContext, row: ProfileRow): Promise<PriceCheck[]> {
    const catalog = this.deps.catalog;
    if (!catalog) return [];
    const providers = new Map((await this.deps.db.select().from(modelProviders)).map((p) => [p.id, p]));
    const targets: PriceTarget[] = [];
    for (const t of [{ providerId: row.providerId, model: row.model }, ...row.fallbacks]) {
      const p = providers.get(t.providerId);
      if (p && isPricedKind(this.deps.registry, p.kind)) targets.push({ providerKind: p.kind, model: t.model, baseModel: baseModelFor(this.deps.registry, p, t.model) });
    }
    try {
      return await ensureCatalogPrices(this.deps.db, await catalog.catalog(), this.deps.registry, actor, targets, nowOf(this.deps));
    } catch {
      return targets.map((t) => ({ providerKind: t.providerKind, model: t.model, status: 'missing', origin: null, source: null, priceId: null }));
    }
  }

  private async assertNameFree(tx: DbOrTx, name: string, exceptId: string | null): Promise<void> {
    const [clash] = await tx.select({ id: modelProfiles.id }).from(modelProfiles).where(eq(modelProfiles.name, name));
    if (clash && clash.id !== exceptId) throw conflict('model_profile_name_taken', `A model profile named ${name} already exists`);
  }

  private async row(db: DbOrTx, id: string, lock = false): Promise<ProfileRow> {
    const query = db.select().from(modelProfiles).where(eq(modelProfiles.id, id));
    const [row] = lock ? await query.for('update') : await query;
    if (!row) throw notFound('model_profile', id);
    return row;
  }

  private async views(rows: ProfileRow[], includeStats: boolean): Promise<ProfileView[]> {
    const ids = rows.map((r) => r.id);
    const [providers, agents, stats] = await Promise.all([
      this.deps.db.select().from(modelProviders),
      agentsByProfile(this.deps.db, ids),
      includeStats ? modelUsageStats(this.deps.db, 'profile', ids, nowOf(this.deps)) : Promise.resolve(null),
    ]);
    const byId = new Map(providers.map((p) => [p.id, p]));
    return rows.map((row) =>
      toProfileView(row, {
        providers: byId,
        agents: agents.get(row.id) ?? [],
        stats: stats ? (stats.get(row.id) ?? EMPTY_USAGE_STATS) : null,
        facts: (provider, model) => modelFacts(this.deps.registry, provider, model),
      }),
    );
  }
}
