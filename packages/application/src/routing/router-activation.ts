import { and, eq, inArray, notInArray } from 'drizzle-orm';
import { notFound, routerReferences, validation, type RouterDefinition } from '@ocso/domain';
import { channels, messageTemplates, modelProfiles, queues, routers, type DbOrTx } from '@ocso/db';
import { recordAudit } from '../audit/audit.js';
import { bumpGeneration } from '../cache/generations.js';
import { emitEvent } from '../events/outbox.js';
import type { ActorContext } from '../shared/context.js';
import { loadRouter, loadVersion, parseDefinition } from './router-load.js';

export interface RouterProblem {
  code: string;
  message: string;
}

/**
 * Activation checks (PM/research/11 §5.2): every referenced queue exists and
 * has its agent; model profiles exist; each per-channel template belongs to
 * the channel it is keyed by and is approved. Approval of the referenced
 * queues, their agents being live, and approval of the profiles are the
 * router approval descriptor's checks (router-approval.ts) — this function is
 * also the trusted seed path's check, which has no approvals.
 */
export async function routerActivationProblems(tx: DbOrTx, def: RouterDefinition): Promise<RouterProblem[]> {
  const refs = routerReferences(def);
  const problems: RouterProblem[] = [];
  const queueRows = refs.queueIds.length ? await tx.select({ id: queues.id, name: queues.name, agentId: queues.agentId }).from(queues).where(inArray(queues.id, refs.queueIds)) : [];
  for (const id of refs.queueIds) {
    const q = queueRows.find((r) => r.id === id);
    if (!q) problems.push({ code: 'queue_not_found', message: `Queue ${id} does not exist` });
    else if (!q.agentId) problems.push({ code: 'queue_without_agent', message: `Queue ${q.name} has no AI agent: give it one before routing to it` });
  }
  if (refs.modelProfileIds.length) {
    const found = new Set((await tx.select({ id: modelProfiles.id }).from(modelProfiles).where(inArray(modelProfiles.id, refs.modelProfileIds))).map((r) => r.id));
    for (const id of refs.modelProfileIds) if (!found.has(id)) problems.push({ code: 'model_profile_not_found', message: `Model profile ${id} does not exist` });
  }
  if (refs.templates.length) {
    const rows = await tx
      .select({ id: messageTemplates.id, channelId: messageTemplates.channelId, name: messageTemplates.name, status: messageTemplates.status, deletedAt: messageTemplates.deletedAt })
      .from(messageTemplates)
      .where(inArray(messageTemplates.id, refs.templates.map((t) => t.templateId)));
    for (const ref of refs.templates) {
      const row = rows.find((r) => r.id === ref.templateId);
      if (!row || row.deletedAt) problems.push({ code: 'template_not_found', message: `Template ${ref.templateId} does not exist` });
      else if (row.channelId !== ref.channelId) problems.push({ code: 'template_wrong_channel', message: `Template ${row.name} belongs to another channel` });
      else if (row.status !== 'APPROVED') problems.push({ code: 'template_not_approved', message: `Template ${row.name} is ${row.status.toLowerCase()}, not approved` });
    }
  }
  return problems;
}

function assertNoProblems(problems: readonly RouterProblem[]): void {
  if (problems.length) throw validation('router_invalid', problems.map((p) => p.message).join('; '), { problems });
}

/**
 * Make a frozen version the router's live behaviour (status ACTIVE). Called by
 * the router approval descriptor's `activate` (and by seeds/tests); never by
 * an HTTP handler directly. Re-validates inside the caller's transaction.
 */
export async function activateRouterVersion(tx: DbOrTx, actor: ActorContext, versionId: string): Promise<void> {
  const version = await loadVersion(tx, versionId);
  if (!version) throw notFound('router_version', versionId);
  const [router] = await tx.select().from(routers).where(eq(routers.id, version.routerId)).for('update');
  if (!router) throw notFound('router', version.routerId);
  const definition = parseDefinition(version.definition);
  assertNoProblems(await routerActivationProblems(tx, definition));
  const now = new Date();
  await tx.update(routers).set({ status: 'ACTIVE', activeVersionId: version.id, updatedAt: now }).where(eq(routers.id, router.id));
  await recordAudit(tx, actor, {
    action: 'router.activate',
    targetType: 'router',
    targetId: router.id,
    summary: `Router ${router.name} now runs version ${version.version}`,
    before: { status: router.status, activeVersionId: router.activeVersionId },
    after: { status: 'ACTIVE', activeVersionId: version.id, version: version.version },
  });
  await emitEvent(tx, actor, 'config.changed', { area: 'router', entityId: router.id });
}

/**
 * Point exactly these channels at the router: channels listed move to it,
 * channels it had and are not listed stop routing (router_id cleared).
 */
export async function attachRouterChannels(tx: DbOrTx, actor: ActorContext, routerId: string, channelIds: readonly string[]): Promise<void> {
  const router = await loadRouter(tx, routerId);
  if (!router) throw notFound('router', routerId);
  const ids = [...new Set(channelIds)];
  const found = ids.length ? await tx.select({ id: channels.id, name: channels.name, routerId: channels.routerId }).from(channels).where(inArray(channels.id, ids)) : [];
  const missing = ids.find((id) => !found.some((c) => c.id === id));
  if (missing) throw notFound('channel', missing);
  const now = new Date();
  const released = await tx
    .update(channels)
    .set({ routerId: null, updatedAt: now })
    .where(and(eq(channels.routerId, routerId), ids.length ? notInArray(channels.id, ids) : undefined))
    .returning({ id: channels.id });
  if (ids.length) await tx.update(channels).set({ routerId, updatedAt: now }).where(inArray(channels.id, ids));
  for (const id of [...ids, ...released.map((r) => r.id)]) await bumpGeneration(tx, actor.correlationId, `channel:${id}`, 'channel_behavior_changed');
  await recordAudit(tx, actor, {
    action: 'router.channels_change',
    targetType: 'router',
    targetId: routerId,
    summary: `Router ${router.name} now routes ${ids.length ? found.map((c) => c.name).join(', ') : 'no channels'}`,
    before: { channelIds: found.filter((c) => c.routerId === routerId).map((c) => c.id).concat(released.map((r) => r.id)) },
    after: { channelIds: ids, movedFrom: found.filter((c) => c.routerId && c.routerId !== routerId).map((c) => ({ channelId: c.id, routerId: c.routerId })) },
  });
  await emitEvent(tx, actor, 'config.changed', { area: 'router_channels', entityId: routerId });
}

/** Stopping is never gated (PM/research/11 §4.5): a disabled router routes nothing; its channels reject `no_router`. */
export async function disableRouter(tx: DbOrTx, actor: ActorContext, routerId: string): Promise<void> {
  const [router] = await tx.select().from(routers).where(eq(routers.id, routerId)).for('update');
  if (!router) throw notFound('router', routerId);
  if (router.status === 'DISABLED') return;
  await tx.update(routers).set({ status: 'DISABLED', updatedAt: new Date() }).where(eq(routers.id, routerId));
  await recordAudit(tx, actor, { action: 'router.disable', targetType: 'router', targetId: routerId, summary: `Disabled router ${router.name}`, before: { status: router.status }, after: { status: 'DISABLED' } });
  await emitEvent(tx, actor, 'config.changed', { area: 'router', entityId: routerId });
}
