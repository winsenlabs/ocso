import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { Permission, can } from '@ocso/auth';
import { channels, conversationRouting, conversations, modelProfiles, queues, routerVersions, routers, teams, type DbOrTx } from '@ocso/db';
import { describeDiff, describeRule, diffFields, notFound, routerReferences, type RouterDefinition } from '@ocso/domain';
import { z } from 'zod';
import type { ApprovalDescriptor, ApprovalProblem, ProposalRow } from '../approvals/contract.js';
import { isApproved, lockObject } from '../approvals/guard.js';
import { dependencyOf } from '../approvals/hashing.js';
import { recordAudit } from '../audit/audit.js';
import { bumpGeneration } from '../cache/generations.js';
import { emitEvent } from '../events/outbox.js';
import type { ActorContext } from '../shared/context.js';
import { modelProfileProblems, queueNames, queueTargetProblems } from './approval-checks.js';
import { activateRouterVersion, attachRouterChannels, routerActivationProblems } from './router-activation.js';
import { parseDefinition, type RouterRow } from './router-load.js';
import { assertRouterInScope, channelsOnOtherRouters, routerTeamIds, teamsOfQueues } from './router-scope.js';

/**
 * The `router` approval kind (PM/research/11 §4.4, §5), checked with
 * approvals.check.routing.
 * - ACTIVATE: the router's newest frozen version goes live (first activation,
 *   a new version, or resuming a DISABLED router). The version is pinned by
 *   the content hash: freezing another version meanwhile voids the proposal.
 * - UPDATE: rename / describe, and attaching channels (a delta — detaching is
 *   a stop and never part of it).
 * - DELETE: always a proposal; refused while channels are attached or
 *   conversations are being routed by it.
 * Disable is the stop action (never a proposal). Validation: every queue the
 * version routes to is approved with a LIVE agent, every model profile is
 * approved, templates belong to their channel and are approved.
 */

export const RouterApprovalPatch = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(500).optional(),
  /** Channels that start routing through this router (moved from another router, or unrouted). */
  attachChannelIds: z.array(z.uuid()).max(200).optional(),
});
export type RouterApprovalPatch = z.infer<typeof RouterApprovalPatch>;

type Projection = Record<string, unknown>;

interface RouterState {
  router: RouterRow;
  latest: { id: string; version: number; definition: RouterDefinition } | null;
  active: { id: string; version: number; definition: RouterDefinition } | null;
  channels: Array<{ id: string; name: string }>;
}

async function loadState(tx: DbOrTx, id: string): Promise<RouterState | null> {
  const [router] = await tx.select().from(routers).where(eq(routers.id, id));
  if (!router) return null;
  const [latest] = await tx.select().from(routerVersions).where(eq(routerVersions.routerId, id)).orderBy(desc(routerVersions.version)).limit(1);
  const [active] = router.activeVersionId ? await tx.select().from(routerVersions).where(eq(routerVersions.id, router.activeVersionId)) : [];
  const attached = await tx.select({ id: channels.id, name: channels.name }).from(channels).where(eq(channels.routerId, id)).orderBy(asc(channels.name));
  const version = (v: typeof latest) => (v ? { id: v.id, version: v.version, definition: parseDefinition(v.definition) } : null);
  return { router, latest: version(latest), active: version(active), channels: attached };
}

/** What a version does, in words a checker can review (names, not ids). */
export async function describeDefinition(tx: DbOrTx, def: RouterDefinition): Promise<Projection> {
  const refs = routerReferences(def);
  const names = await queueNames(tx, refs.queueIds);
  const profiles = refs.modelProfileIds.length ? await tx.select({ id: modelProfiles.id, name: modelProfiles.name }).from(modelProfiles).where(inArray(modelProfiles.id, refs.modelProfileIds)) : [];
  const steps = def.steps.map((s) => {
    if (s.kind === 'ASK') return `Ask “${s.prompt.text}” → ${s.attribute}: ${s.options.map((o) => `${o.label} (${o.value})`).join(', ')}`;
    if (s.kind === 'CLASSIFY') return `Classify with ${profiles.find((p) => p.id === s.modelProfileId)?.name ?? 'missing profile'} → ${s.attribute}: ${s.labels.map((l) => l.value).join(', ')} (≥ ${s.minConfidence})`;
    return `Known ${s.attribute} from ${s.from}`;
  });
  return {
    kind: def.steps.length ? 'steps' : 'pass-through',
    steps,
    rules: def.rules.map((r, i) => `${i + 1}. ${describeRule(r)} → ${names.get(r.queueId)}`),
    fallbackQueue: names.get(def.fallbackQueueId) ?? null,
    returning: def.returning ? `ask “${def.returning.prompt.text}” after ${def.returning.askAfter.value} ${def.returning.askAfter.unit.toLowerCase()}` : null,
    timeoutMinutes: def.timeoutMinutes,
    templates: refs.templates.length,
  };
}

async function project(tx: DbOrTx, s: RouterState, over: { status?: string; version?: RouterState['active']; channels?: string[]; name?: string; description?: string } = {}): Promise<Projection> {
  const version = over.version !== undefined ? over.version : s.active;
  return {
    name: over.name ?? s.router.name,
    description: over.description ?? s.router.description,
    status: over.status ?? s.router.status,
    version: version ? `v${version.version}` : null,
    ...(version ? await describeDefinition(tx, version.definition) : {}),
    // Whose customers these are: a version that moves traffic between teams shows it here, in the diff.
    servedTeams: version ? await teamNames(tx, await teamsOfQueues(tx, routerReferences(version.definition).queueIds)) : [],
    channels: over.channels ?? s.channels.map((c) => c.name),
  };
}

async function teamNames(tx: DbOrTx, ids: readonly string[]): Promise<string[]> {
  return ids.length ? (await tx.select({ name: teams.name }).from(teams).where(inArray(teams.id, [...ids]))).map((t) => t.name).sort() : [];
}

async function channelNames(tx: DbOrTx, ids: readonly string[]): Promise<Array<{ id: string; name: string; routerId: string | null }>> {
  return ids.length ? tx.select({ id: channels.id, name: channels.name, routerId: channels.routerId }).from(channels).where(inArray(channels.id, [...ids])) : [];
}

/** A router's DELETE blockers: channels still attached, conversations it is routing right now. */
async function deleteBlockers(tx: DbOrTx, s: RouterState): Promise<ApprovalProblem[]> {
  const problems: ApprovalProblem[] = [];
  if (s.channels.length) problems.push({ code: 'router_has_channels', message: `Detach ${s.channels.map((c) => c.name).join(', ')} first (detaching is immediate).` });
  const [routing] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(conversationRouting)
    .innerJoin(conversations, eq(conversations.id, conversationRouting.conversationId))
    .where(and(eq(conversationRouting.routerId, s.router.id), eq(conversations.controlState, 'ROUTING')));
  if (routing && routing.n > 0) problems.push({ code: 'router_in_use', message: `${routing.n} conversation(s) are being routed by it right now.` });
  // Its versions are the record of why each past customer was routed where: a router that routed anyone stays (disable it instead).
  const [history] = await tx.select({ n: sql<number>`count(*)::int` }).from(conversationRouting).where(eq(conversationRouting.routerId, s.router.id));
  if (history && history.n > 0 && !(routing && routing.n > 0)) problems.push({ code: 'router_has_history', message: `It has routed ${history.n} conversation(s); its versions are their routing record. Disable it instead (disabling is immediate).` });
  return problems;
}

async function validate(tx: DbOrTx, p: ProposalRow): Promise<ApprovalProblem[]> {
  const s = await loadState(tx, p.objectId);
  if (!s) return [{ code: 'object_missing', message: 'The router no longer exists.' }];
  if (p.action === 'DELETE') return deleteBlockers(tx, s);
  if (p.action === 'ACTIVATE') {
    if (!s.latest) return [{ code: 'no_version', message: 'Freeze the draft into a version first.' }];
    if (s.router.status === 'ACTIVE' && s.router.activeVersionId === s.latest.id) return [{ code: 'already_active', message: `v${s.latest.version} is already live.` }];
    // Someone stopped it since this was proposed: approving must not silently undo the stop. Resuming is its own proposal.
    if (s.router.status === 'DISABLED' && p.beforeSnapshot?.['status'] !== 'DISABLED') {
      return [{ code: 'router_disabled_since', message: `${s.router.name} was disabled after this was proposed: withdraw it and propose resuming the router instead.` }];
    }
    const refs = routerReferences(s.latest.definition);
    // Existence/agent/profile checks are the approval-aware ones below; templates keep the core checks.
    const core = (await routerActivationProblems(tx, s.latest.definition)).filter((x) => x.code.startsWith('template_'));
    return [...core, ...(await queueTargetProblems(tx, refs.queueIds, 'route')), ...(await modelProfileProblems(tx, refs.modelProfileIds))];
  }
  const patch = p.payload as RouterApprovalPatch;
  const problems: ApprovalProblem[] = [];
  if (patch.name && patch.name.toLowerCase() !== s.router.name.toLowerCase()) {
    const [clash] = await tx.select({ id: routers.id }).from(routers).where(and(sql`lower(${routers.name}) = ${patch.name.toLowerCase()}`, ne(routers.id, s.router.id)));
    if (clash) problems.push({ code: 'router_name_taken', message: `A router named ${patch.name} already exists.` });
  }
  const attach = patch.attachChannelIds ?? [];
  const found = await channelNames(tx, attach);
  for (const id of attach) if (!found.some((c) => c.id === id)) problems.push({ code: 'channel_not_found', message: `Channel ${id} does not exist.` });
  for (const c of await channelsOnOtherRouters(tx, s.router.id, attach)) {
    problems.push({ code: 'channel_on_other_router', message: `${c.name} is routed by ${c.routerName}: detach it there first (by that router's teams).` });
  }
  return problems;
}

export const routerApproval: ApprovalDescriptor = {
  kind: 'router',
  label: 'Router',
  actions: ['ACTIVATE', 'UPDATE', 'DELETE'],
  makePermission: () => Permission.ROUTERS_MANAGE,
  checkPermission: Permission.APPROVALS_CHECK_ROUTING,
  payload: RouterApprovalPatch,

  /** ACTIVATE/DELETE always; UPDATE once approved, or when it has ever been live (routers from before approvals). */
  async requiresApproval(tx, id, action) {
    if (action !== 'UPDATE') return true;
    if (await isApproved(tx, 'router', id)) return true;
    const [r] = await tx.select({ status: routers.status }).from(routers).where(eq(routers.id, id));
    return Boolean(r && r.status !== 'DRAFT');
  },
  async lock(tx, id) {
    await lockObject(tx, `router:${id}`);
    await tx.select({ id: routers.id }).from(routers).where(eq(routers.id, id)).for('update');
  },
  async project(tx, id) {
    const s = await loadState(tx, id);
    return s ? project(tx, s) : null;
  },
  async projectAfter(tx, p) {
    const s = await loadState(tx, p.objectId);
    if (!s || p.action === 'DELETE') return null;
    if (p.action === 'ACTIVATE') return project(tx, s, { status: 'ACTIVE', version: s.latest });
    const patch = p.payload as RouterApprovalPatch;
    const added = (await channelNames(tx, patch.attachChannelIds ?? [])).map((c) => c.name);
    return project(tx, s, { channels: [...new Set([...s.channels.map((c) => c.name), ...added])].sort(), ...(patch.name ? { name: patch.name } : {}), ...(patch.description !== undefined ? { description: patch.description } : {}) });
  },
  /** Ids: which version is newest and which is live. Status and attached channels are left out (disable/detach are stops). */
  async hashBasis(tx, id) {
    const s = await loadState(tx, id);
    return s ? { name: s.router.name, description: s.router.description, latestVersionId: s.latest?.id ?? null, activeVersionId: s.router.activeVersionId } : null;
  },
  /** The teams its live version serves (before it has one, its newest version's); none → platform-wide (router-scope.ts). */
  teamIds: routerTeamIds,
  /** Proposing is a write: a router that went live is changed only by the teams it serves. */
  async assertMakeable(tx, principal, id) {
    await assertRouterInScope(tx, principal, id);
  },
  async dependencies(tx, p) {
    if (p.action !== 'ACTIVATE') return [];
    const s = await loadState(tx, p.objectId);
    if (!s?.latest) return [];
    const refs = routerReferences(s.latest.definition);
    const qs = refs.queueIds.length ? await tx.select({ id: queues.id, updatedAt: queues.updatedAt }).from(queues).where(inArray(queues.id, refs.queueIds)) : [];
    const ps = refs.modelProfileIds.length ? await tx.select({ id: modelProfiles.id, updatedAt: modelProfiles.updatedAt }).from(modelProfiles).where(inArray(modelProfiles.id, refs.modelProfileIds)) : [];
    return [...refs.queueIds.map((id) => dependencyOf('queue', id, qs.find((q) => q.id === id)?.updatedAt)), ...refs.modelProfileIds.map((id) => dependencyOf('model_profile', id, ps.find((x) => x.id === id)?.updatedAt))];
  },
  async assertVisible(tx, principal, id) {
    const [r] = await tx.select({ id: routers.id }).from(routers).where(eq(routers.id, id));
    if (!r || !can(principal, Permission.ROUTERS_READ)) throw notFound('router', id);
  },
  validate,
  async activate(tx, actor, p) {
    const s = await loadState(tx, p.objectId);
    if (!s) throw notFound('router', p.objectId);
    if (p.action === 'ACTIVATE') {
      if (!s.latest) throw notFound('router_version', p.objectId);
      await activateRouterVersion(tx, actor, s.latest.id);
    } else if (p.action === 'UPDATE') {
      const patch = p.payload as RouterApprovalPatch;
      if (patch.name !== undefined || patch.description !== undefined) await renameRouter(tx, actor, s.router, patch);
      if (patch.attachChannelIds?.length) await attachRouterChannels(tx, actor, s.router.id, [...new Set([...s.channels.map((c) => c.id), ...patch.attachChannelIds])]);
    } else await deleteRouter(tx, actor, s.router);
    return { kind: 'DONE' };
  },
  async liveObjects(tx) {
    // A disabled router routes nothing (the 0031 grandfather still covers DISABLED ones, so they can be resumed).
    return (await tx.select({ id: routers.id }).from(routers).where(eq(routers.status, 'ACTIVE'))).map((r) => r.id);
  },
  title(p, before) {
    const name = String(before?.['name'] ?? 'router');
    if (p.action === 'DELETE') return `Delete router ${name}`;
    if (p.action === 'ACTIVATE') {
      const version = String(p.afterSnapshot?.['version'] ?? '');
      return before?.['status'] === 'DISABLED' ? `Resume router ${name} (${version})` : `Activate router ${name} ${version}`.trim();
    }
    return `Change router ${name}: ${describeDiff(diffFields(p.beforeSnapshot, p.afterSnapshot))}`;
  },
};

/** Name / description of a router (direct for a draft, or on approval). */
export async function renameRouter(tx: DbOrTx, actor: ActorContext, router: RouterRow, patch: { name?: string | undefined; description?: string | undefined }): Promise<void> {
  const set = { ...(patch.name !== undefined ? { name: patch.name } : {}), ...(patch.description !== undefined ? { description: patch.description } : {}) };
  await tx.update(routers).set({ ...set, updatedAt: new Date() }).where(eq(routers.id, router.id));
  await recordAudit(tx, actor, { action: 'router.update', targetType: 'router', targetId: router.id, summary: `Router ${router.name}: ${Object.keys(set).join(', ')}`, before: { name: router.name, description: router.description }, after: set });
  await emitEvent(tx, actor, 'config.changed', { area: 'router', entityId: router.id });
}

/** Delete an approved DELETE's router (its versions and draft cascade). Only routers that never routed anyone reach here (deleteBlockers). */
export async function deleteRouter(tx: DbOrTx, actor: ActorContext, router: RouterRow): Promise<void> {
  await tx.delete(routers).where(eq(routers.id, router.id));
  await recordAudit(tx, actor, { action: 'router.delete', targetType: 'router', targetId: router.id, summary: `Deleted router ${router.name}`, before: { name: router.name, status: router.status, activeVersionId: router.activeVersionId } });
  await emitEvent(tx, actor, 'config.changed', { area: 'router', entityId: router.id });
}

/**
 * Detach channels (a stop, never gated or locked): they take no new
 * conversations (`no_router`) until attached to another router. Customers
 * already in a conversation are unaffected.
 */
export async function detachRouterChannels(tx: DbOrTx, actor: ActorContext, routerId: string, channelIds: readonly string[]): Promise<string[]> {
  if (!channelIds.length) return [];
  const [router] = await tx.select().from(routers).where(eq(routers.id, routerId)).for('update');
  if (!router) throw notFound('router', routerId);
  const released = await tx
    .update(channels)
    .set({ routerId: null, updatedAt: new Date() })
    .where(and(eq(channels.routerId, routerId), inArray(channels.id, [...channelIds])))
    .returning({ id: channels.id, name: channels.name });
  if (!released.length) return [];
  for (const c of released) await bumpGeneration(tx, actor.correlationId, `channel:${c.id}`, 'channel_behavior_changed');
  await recordAudit(tx, actor, {
    action: 'router.channels_detach',
    targetType: 'router',
    targetId: routerId,
    summary: `Router ${router.name} no longer routes ${released.map((c) => c.name).join(', ')}`,
    before: { channelIds: released.map((c) => c.id) },
    after: { detached: released.map((c) => c.id) },
  });
  await emitEvent(tx, actor, 'config.changed', { area: 'router_channels', entityId: routerId });
  return released.map((c) => c.id);
}
