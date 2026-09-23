import { and, desc, eq, gte, isNull } from 'drizzle-orm';
import { Permission, assertCan } from '@ocso/auth';
import { emitEvent, systemActor, type ActorContext } from '@ocso/application';
import { conflict, notFound, validation } from '@ocso/domain';
import { channels, conversations, copilotSuggestions, users, uuidv7, virtualAgents, type Db } from '@ocso/db';
import type { ModelInputCapabilities } from '@ocso/prompt-compiler';
import type { ContextBuilder } from '../context/context-builder.js';
import type { ModelGateway } from '../model/gateway.js';
import { copilotInstruction, copilotRequest, groundPolicyRefs, parseCopilotOutput, type CopilotStyle } from './instructions.js';

/** A copilot draft exists only while a human holds (or is about to hold) the conversation. */
const COPILOT_STATES: readonly string[] = ['WAITING_FOR_HUMAN', 'HUMAN_ACTIVE'];

type SuggestionRow = typeof copilotSuggestions.$inferSelect;

export interface CopilotSuggestionView {
  id: string;
  conversationId: string;
  text: string;
  status: SuggestionRow['status'];
  basedOnSeq: number;
  agentName: string;
  basis: { historyMessages: number; policyRefs: string[] };
  style: string | null;
  createdAt: string;
}

export interface CopilotDeps {
  db: Db;
  gateway: ModelGateway;
  context: ContextBuilder;
  capabilitiesFor(profileId: string): Promise<ModelInputCapabilities>;
}

/**
 * AI copilot for human-held conversations (PM/BUILD-PLAN E7.9): drafts are
 * suggestions only — never sent automatically — and are usage-accounted as
 * COPILOT. Callers check conversation access.
 */
export class CopilotService {
  constructor(private readonly deps: CopilotDeps) {}

  async draft(actor: ActorContext, conversationId: string, input: { style?: CopilotStyle | undefined; baseText?: string | undefined }): Promise<CopilotSuggestionView> {
    const principal = actor.principal!;
    assertCan(principal, Permission.COPILOT_USE);
    return this.generate(actor, conversationId, {
      requestedBy: principal.userId,
      forName: principal.displayName,
      style: input.style ?? 'default',
      baseText: input.baseText?.trim() || null,
    });
  }

  /** Worker path: one proactive draft per inbound customer message while HUMAN_ACTIVE. */
  async suggest(conversationId: string, seq: number, correlationId: string): Promise<'created' | 'skipped'> {
    const { db } = this.deps;
    const [conv] = await db.select().from(conversations).where(eq(conversations.id, conversationId));
    // A newer message schedules its own suggestion; drafting for an older one is wasted spend.
    if (!conv || conv.controlState !== 'HUMAN_ACTIVE' || conv.lastSeq > seq) return 'skipped';
    const [existing] = await db
      .select({ id: copilotSuggestions.id })
      .from(copilotSuggestions)
      .where(and(eq(copilotSuggestions.conversationId, conversationId), gte(copilotSuggestions.basedOnSeq, seq), isNull(copilotSuggestions.requestedBy)));
    if (existing) return 'skipped';
    const [assignee] = conv.assignedUserId ? await db.select({ name: users.name }).from(users).where(eq(users.id, conv.assignedUserId)) : [];
    await this.generate(systemActor('copilot', correlationId, 'Copilot'), conversationId, { requestedBy: null, forName: assignee?.name ?? null, style: 'default', baseText: null });
    return 'created';
  }

  /** Latest READY draft that still reflects the conversation (null when stale or absent). */
  async latest(conversationId: string): Promise<CopilotSuggestionView | null> {
    const { db } = this.deps;
    const [row] = await db.select().from(copilotSuggestions).where(eq(copilotSuggestions.conversationId, conversationId)).orderBy(desc(copilotSuggestions.createdAt)).limit(1);
    if (!row || row.status !== 'READY') return null;
    const [conv] = await db.select({ lastSeq: conversations.lastSeq, agentName: virtualAgents.name }).from(conversations).innerJoin(virtualAgents, eq(virtualAgents.id, conversations.agentId)).where(eq(conversations.id, conversationId));
    if (!conv || conv.lastSeq > row.basedOnSeq) return null;
    return toView(row, conv.agentName);
  }

  async conversationOf(suggestionId: string): Promise<string> {
    const [row] = await this.deps.db.select({ conversationId: copilotSuggestions.conversationId }).from(copilotSuggestions).where(eq(copilotSuggestions.id, suggestionId));
    if (!row) throw notFound('copilot_suggestion', suggestionId);
    return row.conversationId;
  }

  async recordOutcome(actor: ActorContext, suggestionId: string, outcome: 'INSERTED' | 'DISMISSED'): Promise<void> {
    assertCan(actor.principal!, Permission.COPILOT_USE);
    await this.deps.db
      .update(copilotSuggestions)
      .set({ status: outcome })
      .where(and(eq(copilotSuggestions.id, suggestionId), eq(copilotSuggestions.status, 'READY')));
  }

  private async generate(
    actor: ActorContext,
    conversationId: string,
    opts: { requestedBy: string | null; forName: string | null; style: CopilotStyle; baseText: string | null },
  ): Promise<CopilotSuggestionView> {
    const { db, gateway, context } = this.deps;
    const [conv] = await db.select().from(conversations).where(eq(conversations.id, conversationId));
    if (!conv) throw notFound('conversation', conversationId);
    if (!COPILOT_STATES.includes(conv.controlState)) throw conflict('copilot_unavailable_in_state', 'Copilot drafts are available while a colleague handles the conversation');
    const [agent] = conv.agentId ? await db.select().from(virtualAgents).where(eq(virtualAgents.id, conv.agentId)) : [];
    const profileId = agent?.copilotProfileId ?? agent?.modelProfileId ?? null;
    if (!agent || !agent.copilotEnabled || !profileId) throw validation('copilot_disabled', 'Copilot is not enabled for this agent');
    const [channel] = conv.channelId ? await db.select().from(channels).where(eq(channels.id, conv.channelId)) : [];

    const ctx = await context.build(conv, agent, channel ?? null, await this.deps.capabilitiesFor(profileId), null);
    const system = [...ctx.compiled.system, copilotInstruction(opts)];
    const result = await gateway.run({
      profileId,
      purpose: 'COPILOT',
      system,
      messages: [...ctx.compiled.messages, copilotRequest()],
      // Same tool definitions as the agent keeps the cached prefix identical; the copilot never calls tools.
      tools: ctx.compiled.tools,
      toolChoice: 'none',
      cacheKey: ctx.compiled.hashes.agentPrefixHash,
      context: { correlationId: actor.correlationId, conversationId, agentId: agent.id, userId: opts.requestedBy, purpose: 'COPILOT' },
    });
    const parsed = parseCopilotOutput(result.text);
    if (!parsed.text) throw conflict('copilot_empty', 'The model returned no draft');

    const id = uuidv7();
    const [row] = await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(copilotSuggestions)
        .values({
          id,
          conversationId,
          basedOnSeq: conv.lastSeq,
          text: parsed.text,
          requestedBy: opts.requestedBy,
          style: opts.style === 'default' ? null : opts.style,
          basis: { historyMessages: ctx.compiled.messages.length, policyRefs: groundPolicyRefs(parsed.policyRefs, ctx.compiled.system) },
          usageEventId: result.usageEventId,
        })
        .returning();
      await emitEvent(tx, actor, 'copilot.suggestion', { suggestionId: id }, { conversationId, agentId: agent.id });
      return inserted;
    });
    return toView(row!, agent.name);
  }
}

const toView = (row: SuggestionRow, agentName: string): CopilotSuggestionView => ({
  id: row.id,
  conversationId: row.conversationId,
  text: row.text,
  status: row.status,
  basedOnSeq: row.basedOnSeq,
  agentName,
  basis: row.basis,
  style: row.style,
  createdAt: row.createdAt.toISOString(),
});
