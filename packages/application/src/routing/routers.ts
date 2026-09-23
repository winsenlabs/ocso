import { asc, desc, eq, inArray } from 'drizzle-orm';
import { Permission, assertCan, can, type Principal } from '@ocso/auth';
import { RouterDefinitionSchema, conflict, notFound, type RouterDefinition } from '@ocso/domain';
import { channels, routerDrafts, routerVersions, routers, uuidv7, type Db, type DbOrTx } from '@ocso/db';
import { z } from 'zod';
import { WithApproval } from '../approvals/inputs.js';
import { assertChangeAllowed } from '../approvals/guard.js';
import { recordAudit } from '../audit/audit.js';
import type { ActorContext } from '../shared/context.js';
import { activateRouterVersion, attachRouterChannels, disableRouter, routerActivationProblems, type RouterProblem } from './router-activation.js';
import { detachRouterChannels, renameRouter, routerApproval } from './router-approval.js';
import { agentReach, type AgentReach } from './router-reach.js';
import { parseDefinition, type RouterRow } from './router-load.js';
import { assertRouterInScope, channelsOnOtherRouters } from './router-scope.js';
import { freezeRouterDraft, lockRouter } from './router-writes.js';

export { freezeRouterDraft } from './router-writes.js';
import { simulateRouter, type RouterSimulateInput, type SimulationResult } from './router-simulate.js';
import type { RouterClassifier } from './routing-engine.js';

export const RouterCreateInput = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).default(''),
  definition: RouterDefinitionSchema,
});
export type RouterCreateInput = z.infer<typeof RouterCreateInput>;
export const RouterDraftInput = z.object({ definition: RouterDefinitionSchema, name: z.string().trim().min(1).max(120).optional(), description: z.string().trim().max(500).optional() });
export type RouterDraftInput = z.infer<typeof RouterDraftInput>;
export const RouterVersionInput = z.object({ reason: z.string().trim().max(500).default('') });
/** Activate (or resume with) the router's newest version; `approval` names the checker (PM/research/11 §4.1). */
export const RouterActivateInput = WithApproval.extend({ versionId: z.uuid() });
/** Exactly these channels: the ones left out are detached at once (a stop); new ones need approval once the router is approved. */
export const RouterChannelsInput = WithApproval.extend({ channelIds: z.array(z.uuid()).max(200) });
export const RouterUpdateInput = WithApproval.extend({ name: z.string().trim().min(1).max(120).optional(), description: z.string().trim().max(500).optional() });
export type RouterUpdateInput = z.infer<typeof RouterUpdateInput>;

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
  /** The newest frozen version: what an activation proposal takes live. */
  latestVersionId: string | null;
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
 * Activation, deletion and — once approved — renames and channel attachment
 * are approvals (the `router` descriptor, router-approval.ts); disabling and
 * detaching channels are stops, never gated.
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
      latestVersionId: versions[0]?.id ?? null,
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
        const row = await lockRouter(tx, id);
        await assertRouterInScope(tx, actor.principal!, id);
        // The draft definition is inert (only an approved version goes live); the name is the router's own configuration.
        const renamed = (input.name !== undefined && input.name !== row.name) || (input.description !== undefined && input.description !== row.description);
        if (renamed) await assertChangeAllowed(tx, routerApproval, id, 'UPDATE');
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
    return this.db.transaction(async (tx) => {
      await assertRouterInScope(tx, actor.principal!, id);
      return freezeRouterDraft(tx, actor, id, reason);
    });
  }

  /** Stop: never gated, never locked by a proposal — but only by the teams the router serves (router-scope.ts). */
  async disable(actor: ActorContext, id: string): Promise<void> {
    assertCan(actor.principal!, Permission.ROUTERS_MANAGE);
    await this.db.transaction(async (tx) => {
      await assertRouterInScope(tx, actor.principal!, id);
      await disableRouter(tx, actor, id);
    });
  }

  /**
   * An activation proposal takes the router's newest version live (pinned by the content hash). Asking for an
   * older one is refused: restore it as the draft and freeze it again, so the checker reviews what goes live.
   */
  async assertActivatable(principal: Principal, id: string, versionId: string): Promise<void> {
    assertCan(principal, Permission.ROUTERS_MANAGE);
    const [version] = await this.db.select({ routerId: routerVersions.routerId }).from(routerVersions).where(eq(routerVersions.id, versionId));
    if (!version || version.routerId !== id) throw notFound('router_version', versionId);
    const [latest] = await this.db.select({ id: routerVersions.id }).from(routerVersions).where(eq(routerVersions.routerId, id)).orderBy(desc(routerVersions.version)).limit(1);
    if (latest?.id !== versionId) throw conflict('version_not_latest', 'Only the newest version can be activated: restore this version as the draft and freeze it again.');
  }

  /** Rename / describe a draft router directly (an approved router answers 409 approval_required). */
  async update(actor: ActorContext, id: string, input: Omit<RouterUpdateInput, 'approval'>): Promise<RouterDetail> {
    assertCan(actor.principal!, Permission.ROUTERS_MANAGE);
    try {
      await this.db.transaction(async (tx) => {
        const row = await lockRouter(tx, id);
        await assertRouterInScope(tx, actor.principal!, id);
        await assertChangeAllowed(tx, routerApproval, id, 'UPDATE');
        await renameRouter(tx, actor, row, input);
      });
    } catch (err) {
      if (nameTaken(err)) throw conflict('router_name_taken', `A router named ${input.name} already exists`);
      throw err;
    }
    return this.get(actor.principal!, id);
  }

  /**
   * Split a channel set into the stop (channels left out are detached at once, never locked) and what is new
   * (`attach`, an approvable change once the router is approved).
   */
  async detachExcept(actor: ActorContext, id: string, channelIds: readonly string[]): Promise<{ detached: string[]; attach: string[] }> {
    assertCan(actor.principal!, Permission.ROUTERS_MANAGE);
    return this.db.transaction(async (tx) => {
      const [row] = await tx.select({ id: routers.id }).from(routers).where(eq(routers.id, id));
      if (!row) throw notFound('router', id);
      await assertRouterInScope(tx, actor.principal!, id);
      const current = (await tx.select({ id: channels.id }).from(channels).where(eq(channels.routerId, id))).map((c) => c.id);
      const wanted = [...new Set(channelIds)];
      const detached = await detachRouterChannels(tx, actor, id, current.filter((c) => !wanted.includes(c)));
      return { detached, attach: wanted.filter((c) => !current.includes(c)) };
    });
  }

  /** Attach channels to a draft router directly (it routes nothing until its activation is approved). */
  async attachDirect(actor: ActorContext, id: string, add: readonly string[]): Promise<void> {
    assertCan(actor.principal!, Permission.ROUTERS_MANAGE);
    await this.db.transaction(async (tx) => {
      await lockRouter(tx, id);
      await assertRouterInScope(tx, actor.principal!, id);
      await assertChangeAllowed(tx, routerApproval, id, 'UPDATE');
      // Taking another router's channel would stop its customers' routing without that router's teams: detach it there first.
      const taken = await channelsOnOtherRouters(tx, id, add);
      if (taken.length) throw conflict('channel_on_other_router', `${taken.map((c) => `${c.name} (on ${c.routerName})`).join(', ')}: detach it from that router first.`);
      const current = (await tx.select({ id: channels.id }).from(channels).where(eq(channels.routerId, id))).map((c) => c.id);
      await attachRouterChannels(tx, actor, id, [...new Set([...current, ...add])]);
    });
  }

  /** Approval activation path (the router descriptor) and seeds: make a version live. */
  static activateVersion(tx: DbOrTx, actor: ActorContext, versionId: string): Promise<void> {
    return activateRouterVersion(tx, actor, versionId);
  }

  static attachChannels(tx: DbOrTx, actor: ActorContext, routerId: string, channelIds: readonly string[]): Promise<void> {
    return attachRouterChannels(tx, actor, routerId, channelIds);
  }

  /** "Reached through" for one agent (router-reach.ts). */
  reachOfAgent(principal: Principal, agentId: string): Promise<AgentReach[]> {
    return agentReach(this.db, principal, agentId);
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
