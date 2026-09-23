import { and, eq } from 'drizzle-orm';
import type { ActorContext } from '@ocso/application';
import { escalationRules, promptVersions, virtualAgents } from '@ocso/db';
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
 * authored as the CS Lead would: draft → immutable version → activate.
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
    await ctx.services.escalations.create(lead, agentId, { ...rule, targetQueueId: queues[queue], enabled: true });
  }
}

/**
 * Virtual agents with curated prompts and escalation rules (design/02), each
 * built by a CS Lead of its owning team (ADR-026). Returns ids by slug.
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

/** Link channels and go live (requires an active prompt and a model profile), as the owning team's lead. */
export async function publishAgents(ctx: SeedContext, leads: Record<LeadKey, ActorContext>, agentIds: Record<AgentKey, string>, webchatChannelId: string): Promise<void> {
  for (const agent of AGENTS) {
    const id = agentIds[agent.slug];
    const lead = leads[agent.lead];
    const current = await ctx.services.agents.get(lead.principal!, id);
    if (agent.webchat && !current.channelIds.includes(webchatChannelId)) {
      await ctx.services.agents.update(lead, id, { channelIds: [...current.channelIds, webchatChannelId] });
    }
    if (current.status !== 'LIVE') {
      await ctx.services.agents.setStatus(lead, id, 'LIVE');
      ctx.log(`${agent.name} is live`);
    }
  }
}
