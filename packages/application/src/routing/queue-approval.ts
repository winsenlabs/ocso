import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { Permission } from '@ocso/auth';
import { agentTeams, queues, slaPolicies, teams, virtualAgents, type DbOrTx } from '@ocso/db';
import { describeDiff, diffFields, notFound } from '@ocso/domain';
import type { ApprovalDescriptor, ApprovalProblem, ProposalRow } from '../approvals/contract.js';
import { isApproved } from '../approvals/guard.js';
import { dependencyOf } from '../approvals/hashing.js';
import { loadPerson } from '../approvals/access.js';
import { recordAudit } from '../audit/audit.js';
import { approvalGates, queueNames, queueTargetProblems, slaPolicyProblems } from './approval-checks.js';
import { LIVE_QUEUE_IDS, assertQueueInScope, isLiveQueue, queueLiveReferences } from './queue-guards.js';
import { QueueApprovalPatch, applyQueuePatch, lockQueue, normalizeAttributes, queueTeamIds, type QueueRecord } from './queue-writes.js';

/**
 * The `queue` approval kind (PM/research/11 §4.4, §5.5), checked with
 * approvals.check.routing.
 * - CREATE: a queue is created as a draft (inert: no active router may route
 *   to it); its first approval makes it one routers may use.
 * - UPDATE: once approved — or already reachable by live routing — every
 *   change to agent, attributes, hours, SLA, pickup settings, added teams or
 *   added transfer targets is a proposal (a delta: removals are stops).
 * Stops (never proposals): unlinking your own team (a rights reduction: that
 * team stops seeing and claiming the queue's conversations) and removing a
 * transfer target (narrows where conversations may be moved). Clearing the
 * agent is not a stop — it changes who answers — and is refused while an
 * active router routes to the queue (pause the agent to stop it answering).
 */

type Projection = Record<string, unknown>;

async function state(tx: DbOrTx, id: string): Promise<(QueueRecord & { teamIds: string[] }) | null> {
  const [q] = await tx.select().from(queues).where(eq(queues.id, id));
  return q ? { ...q, teamIds: await queueTeamIds(tx, id) } : null;
}

function applied(s: QueueRecord & { teamIds: string[] }, patch: QueueApprovalPatch): QueueRecord & { teamIds: string[] } {
  const { addTeamIds = [], addTransferTargetIds = [], attributes, ...fields } = patch;
  const defined = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) as Partial<QueueRecord>;
  return {
    ...s,
    ...defined,
    ...(attributes ? { attributes: normalizeAttributes(attributes) } : {}),
    teamIds: [...new Set([...s.teamIds, ...addTeamIds])].sort(),
    transferTargetIds: [...new Set([...s.transferTargetIds, ...addTransferTargetIds])],
  };
}

/** Checker-readable: names, not ids. */
async function project(tx: DbOrTx, s: QueueRecord & { teamIds: string[] }): Promise<Projection> {
  const [agent] = s.agentId ? await tx.select({ name: virtualAgents.name, status: virtualAgents.status }).from(virtualAgents).where(eq(virtualAgents.id, s.agentId)) : [];
  const [sla] = s.slaPolicyId ? await tx.select({ name: slaPolicies.name }).from(slaPolicies).where(eq(slaPolicies.id, s.slaPolicyId)) : [];
  const teamRows = s.teamIds.length ? await tx.select({ name: teams.name }).from(teams).where(inArray(teams.id, s.teamIds)) : [];
  const targets = await queueNames(tx, s.transferTargetIds);
  const targetGates = await approvalGates(tx, 'queue', s.transferTargetIds);
  for (const [id, name] of targets) if (targetGates.get(id) !== 'approved') targets.set(id, `${name} (${targetGates.get(id) === 'pending' ? 'awaiting approval' : 'not approved'})`);
  return {
    name: s.name,
    description: s.description,
    agent: s.agentId ? `${agent?.name ?? 'missing agent'} (${String(agent?.status ?? 'missing').toLowerCase()})` : null,
    attributes: s.attributes,
    teams: teamRows.map((t) => t.name).sort(),
    transferTargets: [...targets.values()].sort(),
    businessHours: s.businessHours,
    slaPolicy: s.slaPolicyId ? (sla?.name ?? 'missing policy') : null,
    mode: s.mode,
    autoAssignAfterSeconds: s.autoAssignAfterSeconds,
    acceptTimeoutSeconds: s.acceptTimeoutSeconds,
    requiredSkills: s.requiredSkills,
    languages: s.languages,
    preferAccountOwner: s.preferAccountOwner,
  };
}

/** Owning teams for checker eligibility: the teams that serve the queue and the teams that own its agent. */
async function owningTeamIds(tx: DbOrTx, id: string): Promise<string[]> {
  const s = await state(tx, id);
  if (!s) return [];
  const agentOwners = s.agentId ? (await tx.select({ teamId: agentTeams.teamId }).from(agentTeams).where(eq(agentTeams.agentId, s.agentId))).map((r) => r.teamId) : [];
  return [...new Set([...s.teamIds, ...agentOwners])].sort();
}

/** Re-exported for the SLA descriptor and the integrator's grandfather check. */
export { LIVE_QUEUE_IDS };

/** A live queue's new agent: LIVE, or going live under an open approval (soft: blocks until it is live). */
async function liveAgentProblems(tx: DbOrTx, agentId: string, queueName: string): Promise<ApprovalProblem[]> {
  const [agent] = await tx.select({ name: virtualAgents.name, status: virtualAgents.status }).from(virtualAgents).where(eq(virtualAgents.id, agentId));
  if (!agent) return [{ code: 'agent_not_found', message: `Agent ${agentId} does not exist.` }];
  if (agent.status === 'LIVE') return [];
  const pending = (await approvalGates(tx, 'agent', [agentId])).get(agentId) === 'pending';
  return [
    pending
      ? { code: 'queue_agent_going_live', message: `${agent.name} is waiting for its go-live approval; customers already reach ${queueName}.`, soft: true }
      : { code: 'queue_agent_not_live', message: `${agent.name} is not live (${agent.status.toLowerCase()}), and customers already reach ${queueName}: take it live first.` },
  ];
}

async function validate(tx: DbOrTx, p: ProposalRow): Promise<ApprovalProblem[]> {
  const s = await state(tx, p.objectId);
  if (!s) return [{ code: 'object_missing', message: 'The queue no longer exists.' }];
  if (p.action === 'CREATE') {
    if (await isApproved(tx, 'queue', p.objectId)) return [{ code: 'already_approved', message: 'This queue has already been approved.' }];
    if (Object.keys(p.payload).length) return [{ code: 'create_takes_no_changes', message: 'Approving a new queue approves it as it is: change the draft first.' }];
    return [...(await queueTargetProblems(tx, s.transferTargetIds, 'transfer')), ...(await slaPolicyProblems(tx, s.slaPolicyId, null))];
  }
  const patch = p.payload as QueueApprovalPatch;
  const next = applied(s, patch);
  const problems: ApprovalProblem[] = [];
  if (patch.name && patch.name.toLowerCase() !== s.name.toLowerCase()) {
    const [clash] = await tx.select({ id: queues.id }).from(queues).where(and(sql`lower(${queues.name}) = ${patch.name.toLowerCase()}`, ne(queues.id, s.id)));
    if (clash) problems.push({ code: 'queue_name_taken', message: `A queue named ${patch.name} already exists.` });
  }
  if (patch.attributes && Object.keys(next.attributes).length) {
    const [clash] = await tx.select({ name: queues.name }).from(queues).where(and(sql`${queues.attributes} = ${JSON.stringify(next.attributes)}::jsonb`, ne(queues.id, s.id)));
    if (clash) problems.push({ code: 'queue_attributes_taken', message: `Queue ${clash.name} already serves exactly these attributes.` });
  }
  if (patch.agentId !== undefined && patch.agentId !== s.agentId) {
    if (patch.agentId === null) {
      const refs = await queueLiveReferences(tx, s.id);
      if (refs.routers.length) problems.push({ code: 'queue_routed', message: `Routers ${refs.routers.join(', ')} route to this queue: route them elsewhere before removing its agent.` });
    } else {
      // The maker names only agents their teams own (ADR-026), re-checked against the maker's current teams.
      const maker = p.makerId ? await loadPerson(tx, p.makerId) : null;
      const [owned] = maker?.teamIds.length
        ? await tx.select({ agentId: agentTeams.agentId }).from(agentTeams).where(and(eq(agentTeams.agentId, patch.agentId), inArray(agentTeams.teamId, [...maker.teamIds]))).limit(1)
        : [];
      if (!owned) problems.push({ code: 'agent_not_yours', message: 'The new agent must be owned by one of the maker’s teams.' });
      // Customers already reach a live queue: its new agent must answer (the router invariant, §5.2).
      if (await isLiveQueue(tx, s.id)) problems.push(...(await liveAgentProblems(tx, patch.agentId, s.name)));
    }
  }
  const addTeams = (patch.addTeamIds ?? []).filter((t) => !s.teamIds.includes(t));
  if (addTeams.length) {
    const found = await tx.select({ id: teams.id }).from(teams).where(inArray(teams.id, addTeams));
    for (const t of addTeams) if (!found.some((r) => r.id === t)) problems.push({ code: 'team_not_found', message: `Team ${t} does not exist.` });
  }
  const newTargets = (patch.addTransferTargetIds ?? []).filter((t) => !s.transferTargetIds.includes(t));
  if (newTargets.includes(s.id)) problems.push({ code: 'transfer_target_self', message: 'A queue cannot transfer to itself.' });
  problems.push(...(await queueTargetProblems(tx, newTargets.filter((t) => t !== s.id), 'transfer')));
  if (patch.slaPolicyId && patch.slaPolicyId !== s.slaPolicyId) problems.push(...(await slaPolicyProblems(tx, patch.slaPolicyId, null)));
  return problems;
}

export const queueApproval: ApprovalDescriptor = {
  kind: 'queue',
  label: 'Queue',
  actions: ['CREATE', 'UPDATE'],
  makePermission: () => Permission.QUEUES_MANAGE,
  checkPermission: Permission.APPROVALS_CHECK_ROUTING,
  payload: QueueApprovalPatch,

  /** CREATE always; UPDATE once approved, or while live routing already reaches it (configuration from before approvals). */
  async requiresApproval(tx, id, action) {
    if (action !== 'UPDATE') return true;
    return (await isApproved(tx, 'queue', id)) || (await isLiveQueue(tx, id));
  },
  async lock(tx, id) {
    await lockQueue(tx, id);
  },
  async project(tx, id) {
    const s = await state(tx, id);
    return s ? project(tx, s) : null;
  },
  async projectAfter(tx, p) {
    const s = await state(tx, p.objectId);
    if (!s) return null;
    return p.action === 'UPDATE' ? project(tx, applied(s, p.payload as QueueApprovalPatch)) : project(tx, s);
  },
  /** Ids, not names; teams and transfer targets left out: removing them is a stop that must not void the proposal. */
  async hashBasis(tx, id) {
    const s = await state(tx, id);
    if (!s) return null;
    const { teamIds: _t, transferTargetIds: _x, createdAt: _c, updatedAt: _u, ...rest } = s;
    return rest;
  },
  teamIds: owningTeamIds,
  async dependencies(tx, p) {
    const s = await state(tx, p.objectId);
    if (!s) return [];
    const policyId = p.action === 'UPDATE' && (p.payload as QueueApprovalPatch).slaPolicyId !== undefined ? (p.payload as QueueApprovalPatch).slaPolicyId : s.slaPolicyId;
    if (!policyId) return [];
    const [policy] = await tx.select({ updatedAt: slaPolicies.updatedAt }).from(slaPolicies).where(eq(slaPolicies.id, policyId));
    return [dependencyOf('sla_policy', policyId, policy?.updatedAt)];
  },
  /** Queues are read by every queues.read holder (the queue list is not team-scoped). */
  async assertVisible(tx, _principal, id) {
    const [q] = await tx.select({ id: queues.id }).from(queues).where(eq(queues.id, id));
    if (!q) throw notFound('queue', id);
  },
  /** Proposing is a write: team-scoped like the direct path (queue-guards.ts). */
  async assertMakeable(tx, principal, id) {
    const [q] = await tx.select({ id: queues.id, agentId: queues.agentId }).from(queues).where(eq(queues.id, id));
    if (!q) throw notFound('queue', id);
    await assertQueueInScope(tx, principal, q);
  },
  validate,
  async activate(tx, actor, p) {
    if (p.action === 'UPDATE') {
      await applyQueuePatch(tx, actor, p.objectId, p.payload as QueueApprovalPatch, 'approved');
      return { kind: 'DONE' };
    }
    // CREATE approves the draft as it is; the row is untouched (its updated_at is other proposals' dependency stamp).
    const [q] = await tx.select({ name: queues.name }).from(queues).where(eq(queues.id, p.objectId));
    await recordAudit(tx, actor, { action: 'queue.approve', targetType: 'queue', targetId: p.objectId, summary: `Queue ${q?.name ?? p.objectId} approved for routing`, after: { proposalId: p.id } });
    return { kind: 'DONE' };
  },
  async liveObjects(tx) {
    return (await tx.execute<{ id: string }>(LIVE_QUEUE_IDS)).rows.map((r) => r.id);
  },
  title(p, before) {
    const name = String(before?.['name'] ?? 'queue');
    if (p.action === 'CREATE') return `Approve queue ${name}`;
    return `Change queue ${name}: ${describeDiff(diffFields(p.beforeSnapshot, p.afterSnapshot))}`;
  },
};
