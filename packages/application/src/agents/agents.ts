import { asc, eq } from 'drizzle-orm';
import { Permission, assertCan } from '@ocso/auth';
import { conflict, notFound, validation } from '@ocso/domain';
import { agentChannels, modelProfiles, promptVersions, virtualAgents, uuidv7, type Db } from '@ocso/db';
import { z } from 'zod';
import { recordAudit } from '../audit/audit.js';
import { bumpGeneration } from '../cache/generations.js';
import { emitEvent } from '../events/outbox.js';
import type { ActorContext } from '../shared/context.js';
import { initialComponents } from './prompt-templates.js';
import { createPromptVersion } from './prompt-versions.js';

const Multimodal = z.object({
  imageInput: z.boolean(),
  documentInput: z.boolean(),
  audioInput: z.boolean(),
  maxMediaPerTurn: z.number().int().min(0).max(20),
});

export const AgentInput = z.object({
  name: z.string().trim().min(1).max(80),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/).optional(),
  purpose: z.string().trim().max(200).default(''),
  conversationType: z.enum(['SUPPORT', 'SALES', 'COLLECTIONS', 'ONBOARDING', 'CUSTOM']),
  description: z.string().max(2_000).default(''),
  modelProfileId: z.uuid().nullable().optional(),
  summarizerProfileId: z.uuid().nullable().optional(),
  copilotProfileId: z.uuid().nullable().optional(),
  defaultQueueId: z.uuid().nullable().optional(),
  multimodal: Multimodal.optional(),
  midTurnPolicy: z.enum(['QUEUE_BEHIND', 'CANCEL_AND_RESTART']).optional(),
  maxToolSteps: z.number().int().min(1).max(20).optional(),
  copilotEnabled: z.boolean().optional(),
  channelIds: z.array(z.uuid()).optional(),
});
export type AgentInput = z.infer<typeof AgentInput>;
export const AgentPatch = AgentInput.partial();
export type AgentPatch = z.infer<typeof AgentPatch>;

export type AgentRow = typeof virtualAgents.$inferSelect;

/** Named virtual agents (docs/01 §4). A logical entity — never bound to a worker. */
export class AgentService {
  constructor(private readonly db: Db) {}

  list(): Promise<AgentRow[]> {
    return this.db.select().from(virtualAgents).orderBy(asc(virtualAgents.name));
  }

  async get(id: string): Promise<AgentRow & { channelIds: string[] }> {
    const [row] = await this.db.select().from(virtualAgents).where(eq(virtualAgents.id, id));
    if (!row) throw notFound('agent', id);
    const channels = await this.db.select({ channelId: agentChannels.channelId }).from(agentChannels).where(eq(agentChannels.agentId, id));
    return { ...row, channelIds: channels.map((c) => c.channelId) };
  }

  async create(actor: ActorContext, input: AgentInput): Promise<AgentRow> {
    assertCan(actor.principal!, Permission.AGENTS_MANAGE);
    const id = uuidv7();
    const slug = input.slug ?? slugify(input.name, id);
    return this.db.transaction(async (tx) => {
      const [clash] = await tx.select({ id: virtualAgents.id }).from(virtualAgents).where(eq(virtualAgents.slug, slug));
      if (clash) throw conflict('agent_slug_taken', `An agent with slug ${slug} already exists`);
      const [agent] = await tx
        .insert(virtualAgents)
        .values({
          id,
          name: input.name,
          slug,
          purpose: input.purpose,
          conversationType: input.conversationType,
          description: input.description,
          modelProfileId: input.modelProfileId ?? null,
          summarizerProfileId: input.summarizerProfileId ?? null,
          copilotProfileId: input.copilotProfileId ?? null,
          defaultQueueId: input.defaultQueueId ?? null,
          ...(input.multimodal ? { multimodal: input.multimodal } : {}),
          ...(input.midTurnPolicy ? { midTurnPolicy: input.midTurnPolicy } : {}),
          ...(input.maxToolSteps ? { maxToolSteps: input.maxToolSteps } : {}),
          createdBy: actor.principal!.userId,
        })
        .returning();
      if (input.channelIds?.length) await tx.insert(agentChannels).values(input.channelIds.map((channelId) => ({ agentId: id, channelId })));
      const version = await createPromptVersion(tx, actor, {
        agentId: id,
        components: initialComponents(input.name, input.purpose, input.conversationType),
        reason: 'Initial version',
        parentVersionId: null,
      });
      await tx.update(virtualAgents).set({ activePromptVersionId: version.id }).where(eq(virtualAgents.id, id));
      await tx.update(promptVersions).set({ firstActivatedAt: new Date() }).where(eq(promptVersions.id, version.id));
      await recordAudit(tx, actor, { action: 'agent.create', targetType: 'agent', targetId: id, summary: `Created virtual agent ${input.name}`, after: input });
      await emitEvent(tx, actor, 'config.changed', { area: 'agent', entityId: id }, { agentId: id });
      return { ...agent!, activePromptVersionId: version.id };
    });
  }

  async update(actor: ActorContext, id: string, patch: AgentPatch): Promise<AgentRow> {
    assertCan(actor.principal!, Permission.AGENTS_MANAGE);
    return this.db.transaction(async (tx) => {
      const [before] = await tx.select().from(virtualAgents).where(eq(virtualAgents.id, id)).for('update');
      if (!before) throw notFound('agent', id);
      const { channelIds, ...fields } = patch;
      const [after] = await tx
        .update(virtualAgents)
        .set({ ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)), updatedAt: new Date() })
        .where(eq(virtualAgents.id, id))
        .returning();
      if (channelIds) {
        await tx.delete(agentChannels).where(eq(agentChannels.agentId, id));
        if (channelIds.length) await tx.insert(agentChannels).values(channelIds.map((channelId) => ({ agentId: id, channelId })));
      }
      await recordAudit(tx, actor, { action: 'agent.update', targetType: 'agent', targetId: id, summary: `Updated ${before.name}`, before, after: patch });
      await bumpGeneration(tx, actor.correlationId, `agent:${id}`, 'agent_config_changed');
      return after!;
    });
  }

  /** Go live / pause. Live requires an active prompt version and a model profile. */
  async setStatus(actor: ActorContext, id: string, status: 'LIVE' | 'PAUSED'): Promise<AgentRow> {
    assertCan(actor.principal!, Permission.AGENTS_MANAGE);
    return this.db.transaction(async (tx) => {
      const [agent] = await tx.select().from(virtualAgents).where(eq(virtualAgents.id, id)).for('update');
      if (!agent) throw notFound('agent', id);
      if (status === 'LIVE') {
        if (!agent.activePromptVersionId) throw validation('agent_not_ready', 'Activate a prompt version before going live');
        if (!agent.modelProfileId) throw validation('agent_not_ready', 'Assign a model profile before going live');
        const [profile] = await tx.select({ id: modelProfiles.id }).from(modelProfiles).where(eq(modelProfiles.id, agent.modelProfileId));
        if (!profile) throw validation('agent_not_ready', 'The assigned model profile no longer exists');
      }
      const [after] = await tx.update(virtualAgents).set({ status, updatedAt: new Date() }).where(eq(virtualAgents.id, id)).returning();
      await recordAudit(tx, actor, {
        action: status === 'LIVE' ? 'agent.go_live' : 'agent.pause',
        targetType: 'agent',
        targetId: id,
        summary: `${agent.name} ${status === 'LIVE' ? 'is live' : 'paused'}`,
      });
      await emitEvent(tx, actor, 'config.changed', { area: 'agent_status', entityId: id }, { agentId: id });
      return after!;
    });
  }
}

function slugify(name: string, id: string): string {
  const base = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return `${base || 'agent'}-${id.slice(-4)}`;
}
