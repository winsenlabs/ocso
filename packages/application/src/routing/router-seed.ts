import { and, eq, isNull } from 'drizzle-orm';
import { passThroughDefinition, type RouterDefinition } from '@ocso/domain';
import { queues, routerDrafts, routers, uuidv7, type Db } from '@ocso/db';
import { recordAudit } from '../audit/audit.js';
import type { ActorContext } from '../shared/context.js';
import { activateRouterVersion, attachRouterChannels } from './router-activation.js';
import { freezeRouterDraft } from './routers.js';

/**
 * Create a router and make it live in one step — for seeds, tests and the
 * approval activation path only (no permission check, no approval): a router
 * whose `definition` is frozen as version 1, activated and attached to the
 * channels. HTTP callers go through RouterService and the approval spine.
 */
export async function createActiveRouter(
  db: Db,
  actor: ActorContext,
  input: { name: string; description?: string; definition: RouterDefinition; channelIds: readonly string[] },
): Promise<{ routerId: string; versionId: string }> {
  return db.transaction(async (tx) => {
    const routerId = uuidv7();
    await tx.insert(routers).values({ id: routerId, name: input.name, description: input.description ?? '', createdBy: actor.principal?.userId ?? null });
    await tx.insert(routerDrafts).values({ routerId, definition: input.definition, updatedBy: actor.principal?.userId ?? null });
    await recordAudit(tx, actor, { action: 'router.create', targetType: 'router', targetId: routerId, summary: `Created router ${input.name}`, after: input });
    const version = await freezeRouterDraft(tx, actor, routerId, 'Initial version');
    await activateRouterVersion(tx, actor, version.id);
    if (input.channelIds.length) await attachRouterChannels(tx, actor, routerId, input.channelIds);
    return { routerId, versionId: version.id };
  });
}

/** The pre-routing behaviour of a channel: every customer goes to one queue (and its agent). */
export function createPassThroughRouter(db: Db, actor: ActorContext, input: { name: string; queueId: string; channelIds: readonly string[] }) {
  return createActiveRouter(db, actor, { name: input.name, definition: passThroughDefinition(input.queueId), channelIds: input.channelIds });
}

/**
 * Tests, seeds and upgrades: make `agentId` answer on `channelId` the way a
 * channel's default agent used to — the queue gets the agent (when it has
 * none) and a pass-through router sends the channel's customers there.
 */
export async function routeChannelToAgent(db: Db, actor: ActorContext, input: { channelId: string; agentId: string; queueId: string; name?: string }): Promise<{ routerId: string; versionId: string }> {
  await db.update(queues).set({ agentId: input.agentId, updatedAt: new Date() }).where(and(eq(queues.id, input.queueId), isNull(queues.agentId)));
  return createPassThroughRouter(db, actor, { name: input.name ?? `Router ${input.channelId.slice(-6)}`, queueId: input.queueId, channelIds: [input.channelId] });
}
