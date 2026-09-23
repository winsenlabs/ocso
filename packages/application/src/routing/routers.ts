import { asc, desc, eq, inArray, max } from 'drizzle-orm';
import { Permission, assertCan, can, type Principal } from '@ocso/auth';
import { RouterDefinitionSchema, conflict, notFound, type RouterDefinition } from '@ocso/domain';
import { channels, routerDrafts, routerVersions, routers, uuidv7, type Db, type DbOrTx } from '@ocso/db';
import { z } from 'zod';
import { recordAudit } from '../audit/audit.js';
import type { ActorContext } from '../shared/context.js';
import { activateRouterVersion, attachRouterChannels, disableRouter, routerActivationProblems, routerApprovalRequired, type RouterProblem } from './router-activation.js';
import { parseDefinition, type RouterRow } from './router-load.js';
import { simulateRouter, type RouterSimulateInput, type SimulationResult } from './router-simulate.js';
import type { RouterClassifier } from './routing-engine.js';

/** `approval: { checkerId, reason }` on approvable writes (PM/research/11 §4.1); the spine consumes it in wave 2. */
export const ApprovalRef = z.object({ checkerId: z.uuid().optional(), reason: z.string().trim().max(2_000).optional(), bootstrap: z.boolean().optional() });

export const RouterCreateInput = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).default(''),
  definition: RouterDefinitionSchema,
});
export type RouterCreateInput = z.infer<typeof RouterCreateInput>;
export const RouterDraftInput = z.object({ definition: RouterDefinitionSchema, name: z.string().trim().min(1).max(120).optional(), description: z.string().trim().max(500).optional() });
export type RouterDraftInput = z.infer<typeof RouterDraftInput>;
export const RouterVersionInput = z.object({ reason: z.string().trim().max(500).default('') });
export const RouterActivateInput = z.object({ versionId: z.uuid(), approval: ApprovalRef.optional() });
export const RouterChannelsInput = z.object({ channelIds: z.array(z.uuid()).max(200), approval: ApprovalRef.optional() });

export type RouterKind = 'PASS_THROUGH' | 'MENU' | 'MODEL' | 'MIXED';

export interface RouterSummary {
  id: string;
  name: string;
  description: string;
  status: RouterRow['status'];
  kind: RouterKind | null;
  activeVersion: { id: string; version: number } | null;
  channels: Array<{ id: string; name: string; kind: string }>;
  draftUpdatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RouterDetail extends RouterSummary {
  draft: { definition: RouterDefinition; updatedAt: string; problems: RouterProblem[] } | null;
  activeDefinition: RouterDefinition | null;
  versions: Array<{ id: string; version: number; reason: string; createdAt: string; createdBy: string | null }>;
}

/** What a definition does, for lists: no steps, only menus, only the model, or both. */
export function routerKind(def: RouterDefinition): RouterKind {
  const kinds = new Set(def.steps.map((s) => s.kind));
  if (!def.steps.length) return 'PASS_THROUGH';
  if (kinds.has('CLASSIFY') && kinds.has('ASK')) return 'MIXED';
  return kinds.has('CLASSIFY') ? 'MODEL' : 'MENU';
}

const nameTaken = (err: unknown) => (err as { code?: string; cause?: { code?: string } }).code === '23505' || (err as { cause?: { code?: string } }).cause?.code === '23505';

/**
 * Routers (PM/research/11 §5.7): CRUD of the draft, frozen versions and a
 * dry-run simulator. Reads need routers.read, writes routers.manage.
 * Activation and channel attachment change live routing, so they are
 * approvals: the HTTP layer answers 409 approval_required and the approval
 * spine calls `activateVersion` / `attachChannels` on approval.
 */
export class RouterService {
  constructor(private readonly db: Db, private readonly classifier: RouterClassifier | null = null) {}

  async list(principal: Principal): Promise<RouterSummary[]> {
    assertCan(principal, Permission.ROUTERS_READ);
    const rows = await this.db.select().from(routers).orderBy(asc(routers.name));
    return this.summaries(this.db, rows);
  }

  async get(principal: Principal, id: string): Promise<RouterDetail> {
    assertCan(principal, Permission.ROUTERS_READ);
    const [row] = await this.db.select().from(routers).where(eq(routers.id, id));
    if (!row) throw notFound('router', id);
    const [summary] = await this.summaries(this.db, [row]);
    const [draft] = await this.db.select().from(routerDrafts).where(eq(routerDrafts.routerId, id));
    const versions = await this.db.select().from(routerVersions).where(eq(routerVersions.routerId, id)).orderBy(desc(routerVersions.version));
    const active = versions.find((v) => v.id === row.activeVersionId);
    const draftDefinition = draft ? RouterDefinitionSchema.safeParse(draft.definition) : null;
    return {
      ...summary!,
      draft: draft && draftDefinition?.success ? { definition: draftDefinition.data, updatedAt: draft.updatedAt.toISOString(), problems: await routerActivationProblems(this.db, draftDefinition.data) } : null,
      activeDefinition: active ? parseDefinition(active.definition) : null,
      versions: versions.map((v) => ({ id: v.id, version: v.version, reason: v.reason, createdAt: v.createdAt.toISOString(), createdBy: v.createdBy })),
    };
  }

  /** A new router is a DRAFT with its draft definition; it routes nothing until a version is approved. */
  async create(actor: ActorContext, input: RouterCreateInput): Promise<RouterDetail> {
    assertCan(actor.principal!, Permission.ROUTERS_MANAGE);
    const id = uuidv7();
    try {
      await this.db.transaction(async (tx) => {
        await tx.insert(routers).values({ id, name: input.name, description: input.description, createdBy: actor.principal!.userId });
        await tx.insert(routerDrafts).values({ routerId: id, definition: input.definition, updatedBy: actor.principal!.userId });
        await recordAudit(tx, actor, { action: 'router.create', targetType: 'router', targetId: id, summary: `Created router ${input.name}`, after: input });
      });
    } catch (err) {
      if (nameTaken(err)) throw conflict('router_name_taken', `A router named ${input.name} already exists`);
      throw err;
    }
    return this.get(actor.principal!, id);
  }

  /** The draft is always editable (it is inert until frozen and approved). */
  async saveDraft(actor: ActorContext, id: string, input: RouterDraftInput): Promise<RouterDetail> {
    assertCan(actor.principal!, Permission.ROUTERS_MANAGE);
    try {
      await this.db.transaction(async (tx) => {
        const [row] = await tx.select().from(routers).where(eq(routers.id, id)).for('update');
        if (!row) throw notFound('router', id);
        const now = new Date();
        await tx
          .insert(routerDrafts)
          .values({ routerId: id, definition: input.definition, updatedBy: actor.principal!.userId, updatedAt: now })
          .onConflictDoUpdate({ target: routerDrafts.routerId, set: { definition: input.definition, updatedBy: actor.principal!.userId, updatedAt: now } });
        if (input.name !== undefined || input.description !== undefined) {
          await tx
            .update(routers)
            .set({ ...(input.name !== undefined ? { name: input.name } : {}), ...(input.description !== undefined ? { description: input.description } : {}), updatedAt: now })
            .where(eq(routers.id, id));
        }
        await recordAudit(tx, actor, { action: 'router.draft_update', targetType: 'router', targetId: id, summary: `Edited the draft of router ${input.name ?? row.name}`, after: input });
      });
    } catch (err) {
      if (nameTaken(err)) throw conflict('router_name_taken', `A router named ${input.name} already exists`);
      throw err;
    }
    return this.get(actor.principal!, id);
  }

  /** Freeze the draft into the next immutable version (what an activation proposal names). */
  async freezeVersion(actor: ActorContext, id: string, reason: string): Promise<{ id: string; version: number }> {
    assertCan(actor.principal!, Permission.ROUTERS_MANAGE);
    return this.db.transaction((tx) => freezeRouterDraft(tx, actor, id, reason));
  }

  /** Stop: never gated. */
  async disable(actor: ActorContext, id: string): Promise<void> {
    assertCan(actor.principal!, Permission.ROUTERS_MANAGE);
    await this.db.transaction((tx) => disableRouter(tx, actor, id));
  }

  /** Until the approval spine handles routers, every activation is a 409 approval_required. */
  async requestActivation(actor: ActorContext, id: string, versionId: string): Promise<never> {
    assertCan(actor.principal!, Permission.ROUTERS_MANAGE);
    const [version] = await this.db.select({ routerId: routerVersions.routerId }).from(routerVersions).where(eq(routerVersions.id, versionId));
    if (!version || version.routerId !== id) throw notFound('router_version', versionId);
    throw routerApprovalRequired(id, 'ACTIVATE');
  }

  async requestChannels(actor: ActorContext, id: string): Promise<never> {
    assertCan(actor.principal!, Permission.ROUTERS_MANAGE);
    const [row] = await this.db.select({ id: routers.id }).from(routers).where(eq(routers.id, id));
    if (!row) throw notFound('router', id);
    throw routerApprovalRequired(id, 'UPDATE');
  }

  /** Approval activation path (the router descriptor) and seeds: make a version live. */
  static activateVersion(tx: DbOrTx, actor: ActorContext, versionId: string): Promise<void> {
    return activateRouterVersion(tx, actor, versionId);
  }

  static attachChannels(tx: DbOrTx, actor: ActorContext, routerId: string, channelIds: readonly string[]): Promise<void> {
    return attachRouterChannels(tx, actor, routerId, channelIds);
  }

  async simulate(principal: Principal, id: string, input: RouterSimulateInput): Promise<SimulationResult> {
    assertCan(principal, Permission.ROUTERS_READ);
    let raw: unknown;
    if (input.versionId) {
      const [version] = await this.db.select().from(routerVersions).where(eq(routerVersions.id, input.versionId));
      if (!version || version.routerId !== id) throw notFound('router_version', input.versionId);
      raw = version.definition;
    } else {
      const [draft] = await this.db.select().from(routerDrafts).where(eq(routerDrafts.routerId, id));
      if (!draft) throw notFound('router', id);
      raw = draft.definition;
    }
    // The model costs money and reaches a provider: only people who may change routers run it. Others
    // (Tech: routers.read) simulate with pinned answers; model steps show as unclassified.
    return simulateRouter(this.db, parseDefinition(raw), input, can(principal, Permission.ROUTERS_MANAGE) ? this.classifier : null);
  }

  private async summaries(db: DbOrTx, rows: RouterRow[]): Promise<RouterSummary[]> {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const [channelRows, drafts, versions] = await Promise.all([
      db.select({ id: channels.id, name: channels.name, kind: channels.kind, routerId: channels.routerId }).from(channels).where(inArray(channels.routerId, ids)).orderBy(asc(channels.name)),
      db.select({ routerId: routerDrafts.routerId, updatedAt: routerDrafts.updatedAt }).from(routerDrafts).where(inArray(routerDrafts.routerId, ids)),
      db.select({ id: routerVersions.id, version: routerVersions.version, definition: routerVersions.definition }).from(routerVersions).where(inArray(routerVersions.id, rows.flatMap((r) => (r.activeVersionId ? [r.activeVersionId] : [])))),
    ]);
    return rows.map((r) => {
      const active = versions.find((v) => v.id === r.activeVersionId);
      const parsed = active ? RouterDefinitionSchema.safeParse(active.definition) : null;
      return {
        id: r.id,
        name: r.name,
        description: r.description,
        status: r.status,
        kind: parsed?.success ? routerKind(parsed.data) : null,
        activeVersion: active ? { id: active.id, version: active.version } : null,
        channels: channelRows.filter((c) => c.routerId === r.id).map(({ routerId: _r, ...c }) => c),
        draftUpdatedAt: drafts.find((d) => d.routerId === r.id)?.updatedAt.toISOString() ?? null,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      };
    });
  }
}

/** Freeze a router's draft into version n+1 (structurally valid by construction; references checked at activation). */
export async function freezeRouterDraft(tx: DbOrTx, actor: ActorContext, routerId: string, reason: string): Promise<{ id: string; version: number }> {
  const [router] = await tx.select().from(routers).where(eq(routers.id, routerId)).for('update');
  if (!router) throw notFound('router', routerId);
  const [draft] = await tx.select().from(routerDrafts).where(eq(routerDrafts.routerId, routerId));
  if (!draft) throw notFound('router_draft', routerId);
  const definition = parseDefinition(draft.definition);
  const [last] = await tx.select({ v: max(routerVersions.version) }).from(routerVersions).where(eq(routerVersions.routerId, routerId));
  const version = (last?.v ?? 0) + 1;
  const id = uuidv7();
  await tx.insert(routerVersions).values({ id, routerId, version, definition, reason, createdBy: actor.principal?.userId ?? null });
  await recordAudit(tx, actor, { action: 'router.version_create', targetType: 'router', targetId: routerId, summary: `Router ${router.name}: version ${version}${reason ? ` — ${reason}` : ''}`, after: { versionId: id, version, definition } });
  return { id, version };
}
