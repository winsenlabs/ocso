import { and, count, eq, inArray } from 'drizzle-orm';
import { WEEKDAYS, isAlwaysOpen, notFound, validation, type BusinessHoursInput } from '@ocso/domain';
import { channels, conversations, handoffs, modelProfiles, modelProviders, virtualAgents, type DbOrTx } from '@ocso/db';
import { recordAudit } from '../audit/audit.js';
import { bumpGeneration } from '../cache/generations.js';
import { emitEvent } from '../events/outbox.js';
import type { ApprovalProblem } from '../approvals/contract.js';
import type { ActorContext } from '../shared/context.js';
import { routedQueueBlockers } from '../routing/queue-guards.js';
import { owningTeams } from './access.js';
import { replaceOwners } from './owners.js';
import type { AgentPatch, AgentRow, AgentView } from './inputs.js';

/**
 * The writes behind an agent's lifecycle, shared by the direct path
 * (AgentService, for drafts and stop actions) and by approval activation
 * (agents/approval.ts). Callers authorize and guard; these only apply, audit
 * and invalidate caches, inside the caller's transaction.
 */

export async function lockAgent(tx: DbOrTx, id: string): Promise<AgentRow> {
  const [row] = await tx.select().from(virtualAgents).where(eq(virtualAgents.id, id)).for('update');
  if (!row) throw notFound('agent', id);
  return row;
}

export async function applyAgentUpdate(tx: DbOrTx, actor: ActorContext, id: string, patch: AgentPatch): Promise<AgentView> {
  const before = await lockAgent(tx, id);
  const { channelIds, teamIds, ...fields } = patch;
  rejectChannelIds(channelIds);
  if (teamIds) await replaceOwners(tx, actor, before, teamIds, 'OWN_TEAMS');
  const [after] = await tx
    .update(virtualAgents)
    .set({ ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)), updatedAt: new Date() })
    .where(eq(virtualAgents.id, id))
    .returning();
  const hours = patch.businessHours ? ` · business hours ${describeHours(patch.businessHours)}` : '';
  await recordAudit(tx, actor, { action: 'agent.update', targetType: 'agent', targetId: id, summary: `Updated ${before.name}${hours}`, before, after: patch });
  await bumpGeneration(tx, actor.correlationId, `agent:${id}`, 'agent_config_changed');
  if (patch.businessHours) {
    // Waiting AUTO_ASSIGN handoffs held for the old next opening are re-evaluated on the next auto-assign sweep.
    const waiting = tx.select({ id: conversations.id }).from(conversations).where(and(eq(conversations.agentId, id), eq(conversations.controlState, 'WAITING_FOR_HUMAN')));
    await tx.update(handoffs).set({ autoAssignAt: null }).where(and(eq(handoffs.status, 'WAITING'), eq(handoffs.mode, 'AUTO_ASSIGN'), inArray(handoffs.conversationId, waiting)));
  }
  return { ...after!, teams: (await owningTeams(tx, [id])).get(id) ?? [] };
}

/** What stops an agent from going live: an active prompt version, and a model profile whose provider is enabled. */
export async function liveReadiness(tx: DbOrTx, agent: Pick<AgentRow, 'activePromptVersionId' | 'modelProfileId'>): Promise<ApprovalProblem[]> {
  const problems: ApprovalProblem[] = [];
  if (!agent.activePromptVersionId) problems.push({ code: 'agent_not_ready', message: 'Activate a prompt version before going live.' });
  if (!agent.modelProfileId) {
    problems.push({ code: 'agent_not_ready', message: 'Assign a model profile before going live.' });
    return problems;
  }
  const [profile] = await tx
    .select({ id: modelProfiles.id, enabled: modelProviders.enabled, provider: modelProviders.name })
    .from(modelProfiles)
    .innerJoin(modelProviders, eq(modelProviders.id, modelProfiles.providerId))
    .where(eq(modelProfiles.id, agent.modelProfileId));
  if (!profile) problems.push({ code: 'agent_not_ready', message: 'The assigned model profile no longer exists.' });
  else if (!profile.enabled) problems.push({ code: 'provider_disabled', message: `The model provider ${profile.provider} is disabled.` });
  return problems;
}

/** Go live (activation of an approved ACTIVATE) or pause (a stop action, never gated). */
export async function applyAgentStatus(tx: DbOrTx, actor: ActorContext, id: string, status: 'LIVE' | 'PAUSED'): Promise<AgentRow> {
  const agent = await lockAgent(tx, id);
  const [after] = await tx.update(virtualAgents).set({ status, updatedAt: new Date() }).where(eq(virtualAgents.id, id)).returning();
  const resumed = status === 'LIVE' && agent.status === 'PAUSED';
  await recordAudit(tx, actor, {
    action: status === 'LIVE' ? 'agent.go_live' : 'agent.pause',
    targetType: 'agent',
    targetId: id,
    summary: `${agent.name} ${status === 'LIVE' ? (resumed ? 'resumed' : 'is live') : 'paused'}`,
  });
  await emitEvent(tx, actor, 'config.changed', { area: 'agent_status', entityId: id }, { agentId: id });
  return after!;
}

/** Why an agent cannot be deleted: live agents are paused first; agents with conversation history are kept (pause instead). */
export async function deleteBlockers(tx: DbOrTx, agent: Pick<AgentRow, 'id' | 'status'>): Promise<ApprovalProblem[]> {
  const problems: ApprovalProblem[] = [];
  if (agent.status === 'LIVE') problems.push({ code: 'agent_live', message: 'Pause the agent before deleting it.' });
  const [history] = await tx.select({ n: count() }).from(conversations).where(eq(conversations.agentId, agent.id));
  if ((history?.n ?? 0) > 0) problems.push({ code: 'agent_has_history', message: `The agent has ${history!.n} conversation(s) on record; pause it instead so the history stays attributable.` });
  problems.push(...(await routedQueueBlockers(tx, agent.id)));
  return problems;
}

/** Delete (activation of an approved DELETE). Channels routed to it stop routing to it; prompts, drafts and grants cascade. */
export async function applyAgentDelete(tx: DbOrTx, actor: ActorContext, id: string): Promise<void> {
  const agent = await lockAgent(tx, id);
  // Queues it served lose their agent (FK ON DELETE SET NULL); routers then use their fallback queue.
  // channels.default_agent_id is deprecated and unread (routing, 0025) but still a NO ACTION foreign key.
  await tx.update(channels).set({ defaultAgentId: null }).where(eq(channels.defaultAgentId, id));
  // Prompt versions are immutable; the guard (0023) lets them go only with an agent whose DELETE is APPROVED.
  await tx.delete(virtualAgents).where(eq(virtualAgents.id, id));
  await recordAudit(tx, actor, { action: 'agent.delete', targetType: 'agent', targetId: id, summary: `Deleted virtual agent ${agent.name}`, before: agent });
  await bumpGeneration(tx, actor.correlationId, `agent:${id}`, 'agent_config_changed');
  await emitEvent(tx, actor, 'config.changed', { area: 'agent', entityId: id }, { agentId: id });
}

/** Audit summary: "humans 24×7" or "mon 08:00–23:00, … (Asia/Kolkata)". */
export function describeHours(hours: BusinessHoursInput): string {
  if (isAlwaysOpen(hours)) return 'humans 24×7';
  const days = WEEKDAYS.filter((d) => hours.humanHours[d]).map((d) => `${d} ${hours.humanHours[d]![0]}–${hours.humanHours[d]![1]}`);
  return `${days.join(', ')} (${hours.timezone})`;
}

/**
 * Channels no longer name an agent (PM/research/11 §5): a channel reaches an
 * agent through its router and a queue that agent serves. Setting channels on
 * an agent is refused with the way to do it instead.
 */
export function rejectChannelIds(channelIds: readonly string[] | undefined): void {
  if (channelIds?.length) {
    throw validation('channels_route_through_routers', 'Channels reach agents through routers: give a queue this agent and route the channel to that queue.');
  }
}
