import { and, asc, eq, inArray, ne } from 'drizzle-orm';
import { Permission } from '@ocso/auth';
import { agentToolGrants, channels, escalationRules, modelProfiles, promptVersions, queues, tools, virtualAgents, type DbOrTx } from '@ocso/db';
import { describeDiff, diffFields } from '@ocso/domain';
import type { ApprovalDescriptor, ApprovalProblem, ProposalRow } from '../approvals/contract.js';
import { dependencyOf } from '../approvals/hashing.js';
import { assertAgentManageable, assertAgentReadable, owningTeams } from './access.js';
import { agentFamily, lockAgentConfig } from './approval-lock.js';
import { applyAgentDelete, applyAgentStatus, applyAgentUpdate, deleteBlockers, liveReadiness } from './agent-writes.js';
import { AgentApprovalPatch, type AgentPatch, type AgentRow } from './inputs.js';
import { reachForAgents } from '../routing/reach.js';

export { promptVersionApproval } from './prompt-approval.js';

/**
 * Reference approval descriptors (PM/research/11 §4, 11b): virtual agents and
 * their prompt versions, checked with approvals.check.agents.
 *
 * - agent ACTIVATE: the first approval takes a draft live; resuming a paused
 *   agent is an ACTIVATE too. Pause is a stop action and never a proposal.
 * - agent UPDATE: any change to an agent that has been approved.
 * - agent DELETE: agents.delete (Head), always a proposal.
 * - prompt_version ACTIVATE (prompt-approval.ts): once the agent has been
 *   approved; a draft agent's prompt activates directly (the go-live approval
 *   shows the checker the prompt text, tools and escalation rules going live).
 *
 * An agent and its prompt versions share one lock (approval-lock.ts).
 */

type AgentProjection = Record<string, unknown>;
type AgentState = Pick<
  AgentRow,
  | 'name'
  | 'slug'
  | 'purpose'
  | 'description'
  | 'conversationType'
  | 'status'
  | 'modelProfileId'
  | 'summarizerProfileId'
  | 'copilotProfileId'
  | 'defaultQueueId'
  | 'multimodal'
  | 'businessHours'
  | 'midTurnPolicy'
  | 'maxToolSteps'
  | 'copilotEnabled'
  | 'activePromptVersionId'
> & { id: string; channelIds: string[] };

async function loadState(tx: DbOrTx, id: string): Promise<AgentState | null> {
  const [a] = await tx.select().from(virtualAgents).where(eq(virtualAgents.id, id));
  if (!a) return null;
  // Channels reach an agent through routers and queues (PM/research/11 §5); shown for context, not changed here.
  const links = await reachForAgents(tx, [id]);
  return { ...a, channelIds: [...new Set(links.map((l) => l.channelId))].sort() };
}

async function nameOf(tx: DbOrTx, table: typeof modelProfiles | typeof queues, id: string | null): Promise<string | null> {
  if (!id) return null;
  const [row] = await tx.select({ name: table.name }).from(table).where(eq(table.id, id));
  return row?.name ?? `missing (${id.slice(0, 8)})`;
}

/** What else goes live with the agent: its tool grants and its own escalation rules (names, never secrets). */
async function behaviour(tx: DbOrTx, agentId: string) {
  const grants = await tx
    .select({ toolId: agentToolGrants.toolId, name: tools.name, enabled: agentToolGrants.enabled, alwaysConfirm: agentToolGrants.alwaysConfirm, argumentRules: agentToolGrants.argumentRules })
    .from(agentToolGrants)
    .leftJoin(tools, eq(tools.id, agentToolGrants.toolId))
    .where(eq(agentToolGrants.agentId, agentId))
    .orderBy(asc(agentToolGrants.toolId));
  const rules = await tx
    .select({ id: escalationRules.id, name: escalationRules.name, trigger: escalationRules.trigger, enabled: escalationRules.enabled, updatedAt: escalationRules.updatedAt })
    .from(escalationRules)
    .where(eq(escalationRules.agentId, agentId))
    .orderBy(asc(escalationRules.id));
  return { grants, rules };
}

/** Checker-readable: names instead of ids for what the agent points at, and the prompt text itself. Never secrets. */
async function projectState(tx: DbOrTx, s: AgentState): Promise<AgentProjection> {
  const [prompt] = s.activePromptVersionId
    ? await tx.select({ version: promptVersions.version, hash: promptVersions.promptHash, components: promptVersions.components }).from(promptVersions).where(eq(promptVersions.id, s.activePromptVersionId))
    : [];
  const channelNames = s.channelIds.length ? (await tx.select({ name: channels.name }).from(channels).where(inArray(channels.id, s.channelIds)).orderBy(asc(channels.name))).map((c) => c.name) : [];
  const { grants, rules } = await behaviour(tx, s.id);
  return {
    name: s.name,
    slug: s.slug,
    purpose: s.purpose,
    description: s.description,
    conversationType: s.conversationType,
    status: s.status,
    modelProfile: await nameOf(tx, modelProfiles, s.modelProfileId),
    summarizerProfile: await nameOf(tx, modelProfiles, s.summarizerProfileId),
    copilotProfile: await nameOf(tx, modelProfiles, s.copilotProfileId),
    defaultQueue: await nameOf(tx, queues, s.defaultQueueId),
    channels: channelNames,
    activePrompt: prompt ? `v${prompt.version} · ${prompt.hash}` : null,
    promptText: prompt?.components ?? null,
    tools: grants.map((g) => `${g.name ?? g.toolId}${g.enabled ? '' : ' (disabled)'}${g.alwaysConfirm ? ' · always confirm' : ''}${g.argumentRules.length ? ` · ${g.argumentRules.length} argument rule(s)` : ''}`).sort(),
    escalationRules: rules.map((r) => `${r.name} (${r.trigger})${r.enabled ? '' : ' · disabled'}`).sort(),
    multimodal: s.multimodal,
    businessHours: s.businessHours,
    midTurnPolicy: s.midTurnPolicy,
    maxToolSteps: s.maxToolSteps,
    copilotEnabled: s.copilotEnabled,
    owningTeams: ((await owningTeams(tx, [s.id])).get(s.id) ?? []).map((t) => t.name),
  };
}

/**
 * What the content hash covers: identifiers, not names (renaming a queue or re-routing a channel elsewhere
 * must not void every open agent proposal), and not the status (pausing is a stop action). Tool grants and
 * escalation rules are in it, so what goes live is exactly what the checker saw.
 */
async function hashBasis(tx: DbOrTx, id: string): Promise<Record<string, unknown> | null> {
  const [a] = await tx.select().from(virtualAgents).where(eq(virtualAgents.id, id));
  if (!a) return null;
  const { grants, rules } = await behaviour(tx, id);
  const teams = ((await owningTeams(tx, [id])).get(id) ?? []).map((t) => t.id).sort();
  return {
    name: a.name,
    slug: a.slug,
    purpose: a.purpose,
    description: a.description,
    conversationType: a.conversationType,
    modelProfileId: a.modelProfileId,
    summarizerProfileId: a.summarizerProfileId,
    copilotProfileId: a.copilotProfileId,
    defaultQueueId: a.defaultQueueId,
    activePromptVersionId: a.activePromptVersionId,
    multimodal: a.multimodal,
    businessHours: a.businessHours,
    midTurnPolicy: a.midTurnPolicy,
    maxToolSteps: a.maxToolSteps,
    copilotEnabled: a.copilotEnabled,
    owningTeamIds: teams,
    toolGrants: grants.map((g) => ({ toolId: g.toolId, enabled: g.enabled, alwaysConfirm: g.alwaysConfirm, argumentRules: g.argumentRules })),
    escalationRules: rules.map((r) => `${r.id}@${r.updatedAt.toISOString()}`),
  };
}

function applyPatch(s: AgentState, patch: AgentPatch): AgentState {
  const defined = Object.fromEntries(Object.entries(patch).filter(([k, v]) => v !== undefined && k !== 'teamIds' && k !== 'channelIds')) as Partial<AgentState>;
  return { ...s, ...defined, channelIds: s.channelIds };
}

async function afterState(tx: DbOrTx, p: ProposalRow): Promise<AgentState | null> {
  const s = await loadState(tx, p.objectId);
  if (!s || p.action === 'DELETE') return null;
  if (p.action === 'ACTIVATE') return { ...s, status: 'LIVE' };
  return applyPatch(s, p.payload as AgentPatch);
}

export const agentApproval: ApprovalDescriptor = {
  kind: 'agent',
  label: 'Virtual agent',
  actions: ['ACTIVATE', 'UPDATE', 'DELETE'],
  makePermission: (action) => (action === 'DELETE' ? Permission.AGENTS_DELETE : Permission.AGENTS_MANAGE),
  checkPermission: Permission.APPROVALS_CHECK_AGENTS,
  payload: AgentApprovalPatch,
  // Pausing (a stop action) must not void an open proposal: status is not in the hash basis; activation re-validates it.
  hashBasis,
  lock: lockAgentConfig,
  related: async (tx, id) => (await agentFamily(tx, id)).filter((f) => f.kind !== 'agent'),

  async project(tx, id) {
    const s = await loadState(tx, id);
    return s ? projectState(tx, s) : null;
  },
  async projectAfter(tx, p) {
    const s = await afterState(tx, p);
    return s ? projectState(tx, s) : null;
  },
  async teamIds(tx, id) {
    return ((await owningTeams(tx, [id])).get(id) ?? []).map((t) => t.id);
  },
  async dependencies(tx, p) {
    const s = await afterState(tx, p);
    if (!s) return [];
    const profileIds = [...new Set([s.modelProfileId, s.summarizerProfileId, s.copilotProfileId].filter((x): x is string => Boolean(x)))];
    const profiles = profileIds.length ? await tx.select({ id: modelProfiles.id, updatedAt: modelProfiles.updatedAt }).from(modelProfiles).where(inArray(modelProfiles.id, profileIds)) : [];
    const deps = profileIds.map((id) => dependencyOf('model_profile', id, profiles.find((x) => x.id === id)?.updatedAt));
    if (s.defaultQueueId) {
      const [q] = await tx.select({ updatedAt: queues.updatedAt }).from(queues).where(eq(queues.id, s.defaultQueueId));
      deps.push(dependencyOf('queue', s.defaultQueueId, q?.updatedAt));
    }
    return deps;
  },
  assertVisible: (tx, principal, id) => assertAgentReadable(tx, principal, id),
  // Proposing is a write: scoped by owning team, like the direct path (agents.read_all reads, never manages).
  assertMakeable: (tx, principal, id) => assertAgentManageable(tx, principal, id),
  async validate(tx, p) {
    const [agent] = await tx.select().from(virtualAgents).where(eq(virtualAgents.id, p.objectId));
    if (!agent) return [{ code: 'object_missing', message: 'The agent no longer exists.' }];
    if (p.action === 'DELETE') return deleteBlockers(tx, agent);
    const patch = p.payload as AgentPatch;
    const next = p.action === 'ACTIVATE' ? agent : { ...agent, ...(applyPatch({ ...agent, channelIds: [] }, patch) as Partial<AgentRow>) };
    const problems: ApprovalProblem[] = [];
    if (p.action === 'UPDATE' && patch.channelIds?.length) {
      problems.push({ code: 'channels_route_through_routers', message: 'Channels reach agents through routers: give a queue this agent and route the channel to that queue.' });
    }
    if (p.action === 'UPDATE' && patch.slug && patch.slug !== agent.slug) {
      const [clash] = await tx.select({ id: virtualAgents.id }).from(virtualAgents).where(and(eq(virtualAgents.slug, patch.slug), ne(virtualAgents.id, agent.id)));
      if (clash) problems.push({ code: 'agent_slug_taken', message: `An agent with slug ${patch.slug} already exists.` });
    }
    if (p.action === 'ACTIVATE' && agent.status === 'LIVE') problems.push({ code: 'already_live', message: 'The agent is already live.' });
    // A live (or paused, resumable) agent must stay ready to answer; ACTIVATE checks the same.
    if (p.action === 'ACTIVATE' || agent.status !== 'DRAFT') problems.push(...(await liveReadiness(tx, next)));
    return problems;
  },
  async activate(tx, actor, p) {
    if (p.action === 'ACTIVATE') await applyAgentStatus(tx, actor, p.objectId, 'LIVE');
    else if (p.action === 'UPDATE') await applyAgentUpdate(tx, actor, p.objectId, p.payload as AgentPatch);
    else await applyAgentDelete(tx, actor, p.objectId);
    return { kind: 'DONE' };
  },
  async liveObjects(tx) {
    return (await tx.select({ id: virtualAgents.id }).from(virtualAgents).where(inArray(virtualAgents.status, ['LIVE', 'PAUSED']))).map((r) => r.id);
  },
  title(p, before) {
    const name = String(before?.['name'] ?? 'agent');
    if (p.action === 'DELETE') return `Delete ${name}`;
    if (p.action === 'ACTIVATE') return before?.['status'] === 'PAUSED' ? `Resume ${name}` : `Take ${name} live`;
    return `Change ${name}: ${describeDiff(diffFields(p.beforeSnapshot, p.afterSnapshot))}`;
  },
};
