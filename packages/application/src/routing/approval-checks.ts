import { and, eq, inArray } from 'drizzle-orm';
import { approvalProposals, modelProfiles, queues, virtualAgents, type DbOrTx } from '@ocso/db';
import type { ApprovalProblem } from '../approvals/contract.js';

/**
 * What routing configuration may point at (PM/research/11 §5.2, wave 2): a
 * router references only approved queues whose agent is LIVE and approved
 * model profiles; a queue transfers only to approved queues and uses only an
 * approved SLA policy. A reference still waiting for its own approval is a
 * *soft* problem — the maker may submit, the checker sees it, and approving
 * blocks until that approval lands (activation re-validates). Anything else
 * is a hard problem that refuses the submit.
 */

export type ApprovalGate = 'approved' | 'pending' | 'none';

/** Approved (an APPROVED proposal exists), pending (one is open), or neither — per object id. */
export async function approvalGates(tx: DbOrTx, kind: string, ids: readonly string[]): Promise<Map<string, ApprovalGate>> {
  const out = new Map<string, ApprovalGate>(ids.map((id) => [id, 'none']));
  if (!ids.length) return out;
  const rows = await tx
    .select({ objectId: approvalProposals.objectId, status: approvalProposals.status })
    .from(approvalProposals)
    .where(and(eq(approvalProposals.objectKind, kind), inArray(approvalProposals.objectId, [...new Set(ids)]), inArray(approvalProposals.status, ['APPROVED', 'SUBMITTED'])));
  for (const r of rows) if (r.status === 'APPROVED' || out.get(r.objectId) === 'none') out.set(r.objectId, r.status === 'APPROVED' ? 'approved' : 'pending');
  return out;
}

function gateProblem(gate: ApprovalGate | undefined, code: string, what: string): ApprovalProblem | null {
  if (gate === 'approved') return null;
  if (gate === 'pending') return { code: `${code}_pending`, message: `${what} is still waiting for its own approval: approve that first.`, soft: true };
  return { code, message: `${what} has not been approved yet: submit it for approval first.` };
}

/** Routed-to queues: approved, with an agent, and that agent LIVE (or going live under an open approval). Transfer targets: approved. */
export async function queueTargetProblems(tx: DbOrTx, queueIds: readonly string[], role: 'route' | 'transfer'): Promise<ApprovalProblem[]> {
  const ids = [...new Set(queueIds)];
  if (!ids.length) return [];
  const rows = await tx
    .select({ id: queues.id, name: queues.name, agentId: queues.agentId, agentName: virtualAgents.name, agentStatus: virtualAgents.status })
    .from(queues)
    .leftJoin(virtualAgents, eq(virtualAgents.id, queues.agentId))
    .where(inArray(queues.id, ids));
  const gates = await approvalGates(tx, 'queue', ids);
  const agentGates = await approvalGates(tx, 'agent', rows.flatMap((r) => (r.agentId ? [r.agentId] : [])));
  const problems: ApprovalProblem[] = [];
  const verb = role === 'route' ? 'Routing to' : 'Transferring to';
  for (const id of ids) {
    const q = rows.find((r) => r.id === id);
    if (!q) {
      problems.push({ code: 'queue_not_found', message: `${verb} queue ${id}: it does not exist.` });
      continue;
    }
    // A transfer target whose own first approval is open is accepted (the checker sees it marked in the
    // projection): transfer targets may point at each other, and a cycle could otherwise never be approved.
    // It only needs to be approved or on its way: the AI transfer tool offers only targets whose agent answers.
    const gate = role === 'transfer' && gates.get(id) === 'pending' ? null : gateProblem(gates.get(id), 'queue_not_approved', `Queue ${q.name}`);
    if (gate) problems.push(gate);
    if (role === 'transfer') continue;
    if (!q.agentId) problems.push({ code: 'queue_without_agent', message: `Queue ${q.name} has no AI agent: give it one first.` });
    else if (q.agentStatus !== 'LIVE') {
      // An agent whose go-live is waiting for approval: shown to the checker, blocks until it is live.
      const pending = agentGates.get(q.agentId) === 'pending';
      problems.push({
        code: pending ? 'queue_agent_going_live' : 'queue_agent_not_live',
        message: pending ? `${q.agentName ?? 'The agent'} of queue ${q.name} is waiting for its go-live approval.` : `${q.agentName ?? 'The agent'} of queue ${q.name} is not live (${String(q.agentStatus ?? 'missing').toLowerCase()}).`,
        ...(pending ? { soft: true } : {}),
      });
    }
  }
  return problems;
}

/** Model profiles a router's CLASSIFY steps call: approved (model_profile descriptor, check.platform). */
export async function modelProfileProblems(tx: DbOrTx, profileIds: readonly string[]): Promise<ApprovalProblem[]> {
  const ids = [...new Set(profileIds)];
  if (!ids.length) return [];
  const rows = await tx.select({ id: modelProfiles.id, name: modelProfiles.name }).from(modelProfiles).where(inArray(modelProfiles.id, ids));
  const gates = await approvalGates(tx, 'model_profile', ids);
  const problems: ApprovalProblem[] = [];
  for (const id of ids) {
    const p = rows.find((r) => r.id === id);
    if (!p) problems.push({ code: 'model_profile_not_found', message: `Model profile ${id} does not exist.` });
    else {
      const gate = gateProblem(gates.get(id), 'model_profile_not_approved', `Model profile ${p.name}`);
      if (gate) problems.push(gate);
    }
  }
  return problems;
}

/** An SLA policy a queue uses: approved (or under an open approval — soft). */
export async function slaPolicyProblems(tx: DbOrTx, policyId: string | null, name: string | null): Promise<ApprovalProblem[]> {
  if (!policyId) return [];
  const gate = gateProblem((await approvalGates(tx, 'sla_policy', [policyId])).get(policyId), 'sla_policy_not_approved', `SLA policy ${name ?? policyId}`);
  return gate ? [gate] : [];
}

/** Names for display (missing ids shown shortened, never thrown on). */
export async function queueNames(tx: DbOrTx, ids: readonly string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  if (!unique.length) return new Map();
  const rows = await tx.select({ id: queues.id, name: queues.name }).from(queues).where(inArray(queues.id, unique));
  return new Map(unique.map((id) => [id, rows.find((r) => r.id === id)?.name ?? `missing (${id.slice(0, 8)})`]));
}
