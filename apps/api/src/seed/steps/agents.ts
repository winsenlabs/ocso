import { and, desc, eq, isNull, or } from 'drizzle-orm';
import { approvalGates, type ActorContext } from '@ocso/application';
import { approvalProposals, escalationRules, promptVersions, virtualAgents } from '@ocso/db';
import type { SeedContext } from '../context.js';
import { AGENTS, type AgentKey, type DemoAgent } from '../data/agents.js';
import type { LeadKey, ProfileKey, QueueKey, TeamKey } from '../data/organization.js';

export interface AgentRefs {
  profiles: Record<ProfileKey, string>;
  queues: Record<QueueKey, string>;
  teams: Record<TeamKey, string>;
}

async function ensureAgent(ctx: SeedContext, lead: ActorContext, agent: DemoAgent, refs: AgentRefs): Promise<string> {
  const [existing] = await ctx.db.select({ id: virtualAgents.id }).from(virtualAgents).where(eq(virtualAgents.slug, agent.slug));
  if (existing) return existing.id;
  const created = await ctx.services.agents.create(lead, {
    name: agent.name,
    slug: agent.slug,
    purpose: agent.purpose,
    conversationType: agent.conversationType,
    description: agent.description,
    modelProfileId: refs.profiles[agent.profile],
    summarizerProfileId: refs.profiles.summarizer,
    copilotProfileId: refs.profiles.supportFast,
    defaultQueueId: refs.queues[agent.queue],
    teamIds: agent.owners.map((t) => refs.teams[t]),
    multimodal: agent.multimodal,
    midTurnPolicy: 'QUEUE_BEHIND',
    maxToolSteps: 6,
  });
  ctx.log(`created virtual agent ${agent.name} (${agent.conversationType}, owned by ${agent.owners.join(', ')})`);
  return created.id;
}

/**
 * v1 is the platform template AgentService creates; v2 is the curated prompt,
 * authored as the Lead would: draft → immutable version → activate.
 */
async function ensurePrompt(ctx: SeedContext, lead: ActorContext, agentId: string, agent: DemoAgent): Promise<void> {
  const [version] = await ctx.db
    .select({ id: promptVersions.id })
    .from(promptVersions)
    .where(and(eq(promptVersions.agentId, agentId), eq(promptVersions.reason, agent.promptReason)));
  const [row] = await ctx.db.select({ active: virtualAgents.activePromptVersionId }).from(virtualAgents).where(eq(virtualAgents.id, agentId));
  let versionId = version?.id;
  if (!versionId) {
    await ctx.services.prompts.saveDraft(lead, agentId, agent.prompt);
    versionId = (await ctx.services.prompts.createVersionFromDraft(lead, agentId, { reason: agent.promptReason })).id;
  }
  if (row?.active !== versionId) {
    await ctx.services.prompts.activate(lead, agentId, versionId);
    ctx.log(`activated curated prompt for ${agent.name}`);
  }
}

async function ensureEscalations(ctx: SeedContext, lead: ActorContext, agentId: string, agent: DemoAgent, queues: Record<QueueKey, string>): Promise<void> {
  const existing = await ctx.db.select({ name: escalationRules.name }).from(escalationRules).where(eq(escalationRules.agentId, agentId));
  for (const { queue, ...rule } of agent.escalations) {
    if (existing.some((e) => e.name === rule.name)) continue;
    // A draft (off) until publishAgents turns it on through an approval.
    await ctx.services.escalations.create(lead, agentId, { ...rule, targetQueueId: queues[queue], enabled: false });
  }
}

/**
 * Virtual agents with curated prompts and escalation rules (design/02), each
 * built by a Lead of its owning team (ADR-026). Returns ids by slug.
 */
export async function seedAgents(ctx: SeedContext, leads: Record<LeadKey, ActorContext>, refs: AgentRefs): Promise<Record<AgentKey, string>> {
  const ids = {} as Record<AgentKey, string>;
  for (const agent of AGENTS) {
    const lead = leads[agent.lead];
    const id = await ensureAgent(ctx, lead, agent, refs);
    await ensurePrompt(ctx, lead, id, agent);
    await ensureEscalations(ctx, lead, id, agent, refs.queues);
    ids[agent.slug] = id;
  }
  return ids;
}

/**
 * Go live (requires an active prompt and a model profile) through an approval: the owning team's Head proposes
 * it and the other Head checks it — each demo team has one Head, so the platform-wide fallback makes the
 * other team's Head the eligible checker (never a self-approval). Channels reach agents through routers.
 */
export async function publishAgents(ctx: SeedContext, leads: Record<LeadKey, ActorContext>, agentIds: Record<AgentKey, string>): Promise<void> {
  for (const agent of AGENTS) {
    const id = agentIds[agent.slug];
    const maker = leads[agent.lead];
    const checker = leads[agent.lead === 'lead' ? 'lead2' : 'lead'];
    const current = await ctx.services.agents.get(maker.principal!, id);
    if (current.status !== 'LIVE') {
      await approveAs(ctx, maker, checker, { objectKind: 'agent', objectId: id, action: 'ACTIVATE' }, 'Demo seed: take the agent live');
      ctx.log(`${agent.name} is live (approved by ${checker.principal!.displayName})`);
    }
    // Also on a re-run: an interrupted run may have taken the agent live before its rules were turned on.
    await enableEscalations(ctx, maker, checker, id, agent.name);
  }
}

/** New escalation rules are drafts (off): each is turned on through its own approval, checked by the other Head. */
async function enableEscalations(ctx: SeedContext, maker: ActorContext, checker: ActorContext, agentId: string, agentName: string): Promise<void> {
  const drafts = await ctx.db.select({ id: escalationRules.id }).from(escalationRules).where(and(eq(escalationRules.agentId, agentId), eq(escalationRules.enabled, false)));
  for (const rule of drafts) await approveAs(ctx, maker, checker, { objectKind: 'escalation_rule', objectId: rule.id, action: 'ACTIVATE' }, 'Demo seed: turn the escalation rule on');
  if (drafts.length) ctx.log(`turned on ${drafts.length} escalation rule(s) of ${agentName} (approved by ${checker.principal!.displayName})`);
}

/** Propose as `maker`, approve as `checker` (the demo's two Heads check each other). */
export async function approveAs(
  ctx: SeedContext,
  maker: ActorContext,
  checker: ActorContext,
  target: { objectKind: string; objectId: string; action: 'CREATE' | 'UPDATE' | 'DELETE' | 'ACTIVATE'; payload?: Record<string, unknown> },
  reason: string,
): Promise<void> {
  // Re-runnable after an interruption: finish a proposal an earlier run left open (or approved but not
  // activated) instead of submitting a second one, which would fail with approval_open.
  const unfinished = await unfinishedProposal(ctx, target.objectKind, target.objectId, target.action);
  const proposalId = unfinished?.id ?? (await ctx.services.approvals.submit(maker, { ...target, checkerId: checker.principal!.userId, reason })).id;
  await approveProposal(ctx, checker, proposalId);
}

/** The newest proposal for this object (and action) that is still open, or approved but not yet activated. */
export async function unfinishedProposal(
  ctx: SeedContext,
  objectKind: string,
  objectId: string,
  action?: 'CREATE' | 'UPDATE' | 'DELETE' | 'ACTIVATE',
): Promise<{ id: string; checkerId: string | null } | null> {
  const [row] = await ctx.db
    .select({ id: approvalProposals.id, checkerId: approvalProposals.checkerId })
    .from(approvalProposals)
    .where(
      and(
        eq(approvalProposals.objectKind, objectKind),
        eq(approvalProposals.objectId, objectId),
        action ? eq(approvalProposals.action, action) : undefined,
        or(eq(approvalProposals.status, 'SUBMITTED'), and(eq(approvalProposals.status, 'APPROVED'), isNull(approvalProposals.activatedAt))),
      ),
    )
    .orderBy(desc(approvalProposals.submittedAt))
    .limit(1);
  return row ?? null;
}

/** True when the object's approval (e.g. a draft's first ACTIVATE) has been approved and fully applied. */
export async function isApproved(ctx: SeedContext, objectKind: string, objectId: string): Promise<boolean> {
  if (await unfinishedProposal(ctx, objectKind, objectId)) return false;
  return (await approvalGates(ctx.db, objectKind, [objectId])).get(objectId) === 'approved';
}

/** Approve a proposal someone already submitted (e.g. through a service's `approval` choice), as its named checker. */
export async function approveProposal(ctx: SeedContext, checker: ActorContext, proposalId: string): Promise<void> {
  const proposal = await ctx.services.approvals.get(checker.principal!, proposalId);
  if (proposal.status === 'SUBMITTED') {
    await ctx.services.approvalDecisions.decide(checker, proposalId, { decision: 'APPROVE', reason: 'Demo seed: reviewed', contentHash: proposal.contentHash });
  }
  await finishDeferred(ctx, checker, proposalId);
}

/**
 * The deferred half of an approval (e.g. a new user's invite step) normally runs on the worker's
 * approval-activate job; the seed finishes it itself so the demo is complete without a worker.
 */
export async function finishDeferred(ctx: SeedContext, actor: ActorContext, proposalId: string): Promise<void> {
  const [row] = await ctx.db.select({ status: approvalProposals.status, activatedAt: approvalProposals.activatedAt }).from(approvalProposals).where(eq(approvalProposals.id, proposalId));
  if (row?.status !== 'APPROVED' || row.activatedAt) return;
  const outcome = await ctx.services.approvalDecisions.finishActivation(actor, proposalId);
  if (outcome === 'BLOCKED') throw new Error(`activation of approved proposal ${proposalId} was blocked`);
}
