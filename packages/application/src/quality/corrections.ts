import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { Permission, assertCan, type Principal } from '@ocso/auth';
import { conflict, notFound, validation } from '@ocso/domain';
import { conversations, interactions, promptCorrections, promptVersions, uuidv7, virtualAgents, type Db, type DbOrTx } from '@ocso/db';
import { BUSINESS_COMPONENT_KEYS, type BusinessComponentKey, type PromptComponents } from '@ocso/prompt-compiler';
import { z } from 'zod';
import { assertAgentReadable, manageableAgentsSql, readableAgentFilter } from '../agents/access.js';
import { PromptService } from '../agents/prompt-versions.js';
import { recordAudit } from '../audit/audit.js';
import type { ActorContext } from '../shared/context.js';

export const CorrectionInput = z
  .object({
    agentId: z.uuid().optional(),
    conversationId: z.uuid().optional(),
    /** The turn (interaction seq) the problem was observed at. */
    interactionSeq: z.number().int().min(1).optional(),
    title: z.string().trim().min(3).max(200).optional(),
    observed: z.string().trim().min(3).max(2_000),
    desired: z.string().trim().min(3).max(2_000),
    componentKey: z.enum(BUSINESS_COMPONENT_KEYS),
    proposedText: z.string().trim().min(1).max(20_000).optional(),
  })
  .refine((v) => v.agentId || v.conversationId, 'agentId or conversationId is required')
  .refine((v) => v.interactionSeq === undefined || v.conversationId, 'interactionSeq requires conversationId');
export type CorrectionInput = z.infer<typeof CorrectionInput>;

export const StageCorrectionInput = z.object({
  proposedText: z.string().trim().min(1).max(20_000).optional(),
  /** APPEND adds the text as a new line of the component (idempotent); REPLACE swaps the whole component. */
  mode: z.enum(['APPEND', 'REPLACE']).default('APPEND'),
});
export type StageCorrectionInput = z.infer<typeof StageCorrectionInput>;

export const RejectCorrectionInput = z.object({ reason: z.string().trim().max(500).optional() });
export type RejectCorrectionInput = z.infer<typeof RejectCorrectionInput>;

export const CorrectionQuery = z.object({
  agentId: z.uuid().optional(),
  status: z.enum(['OPEN', 'STAGED', 'APPLIED', 'REJECTED']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type CorrectionQuery = z.infer<typeof CorrectionQuery>;

export type CorrectionRow = typeof promptCorrections.$inferSelect;
export type CorrectionView = Omit<CorrectionRow, 'createdAt' | 'updatedAt'> & { agentName: string; createdAt: string; updatedAt: string };

/** Compose the new component text for staging (pure, for tests and previews). */
export function composeComponent(current: string, text: string, mode: 'APPEND' | 'REPLACE'): string {
  if (mode === 'REPLACE') return text;
  if (current.includes(text)) return current;
  return current.trim() ? `${current.trimEnd()}\n${text}` : text;
}

/**
 * Prompt correction workflow (docs/09 §7): capture source turn, observed and
 * desired behavior and the component to change; stage it into the agent's
 * prompt draft (never the live prompt); a new version with correctionIds marks
 * it APPLIED. Nothing mutates a prompt invisibly: every step is audited.
 * Scoped to the agents the lead's teams own (ADR-026): others are not found.
 */
export class CorrectionService {
  private readonly prompts: PromptService;

  constructor(private readonly db: Db) {
    this.prompts = new PromptService(db);
  }

  async list(principal: Principal, q: CorrectionQuery): Promise<CorrectionView[]> {
    assertCan(principal, Permission.CORRECTIONS_MANAGE);
    if (q.agentId) await assertAgentReadable(this.db, principal, q.agentId);
    const rows = await this.db
      .select({ c: promptCorrections, agentName: virtualAgents.name })
      .from(promptCorrections)
      .innerJoin(virtualAgents, eq(virtualAgents.id, promptCorrections.agentId))
      .where(
        and(
          readableAgentFilter(principal, promptCorrections.agentId),
          q.agentId ? eq(promptCorrections.agentId, q.agentId) : undefined,
          q.status ? eq(promptCorrections.status, q.status) : undefined,
        ),
      )
      .orderBy(asc(sql`array_position(ARRAY['OPEN','STAGED','APPLIED','REJECTED'], ${promptCorrections.status})`), desc(promptCorrections.occurrences), desc(promptCorrections.createdAt))
      .limit(q.limit);
    return rows.map(({ c, agentName }) => view(c, agentName));
  }

  async get(principal: Principal, id: string): Promise<CorrectionView> {
    assertCan(principal, Permission.CORRECTIONS_MANAGE);
    const [row] = await this.db
      .select({ c: promptCorrections, agentName: virtualAgents.name })
      .from(promptCorrections)
      .innerJoin(virtualAgents, eq(virtualAgents.id, promptCorrections.agentId))
      .where(and(eq(promptCorrections.id, id), readableAgentFilter(principal, promptCorrections.agentId)));
    if (!row) throw notFound('prompt_correction', id);
    return view(row.c, row.agentName);
  }

  /**
   * Record a correction. An OPEN/STAGED correction of the same agent, component
   * and (case-insensitive) title is merged: its occurrence count increases.
   */
  async create(actor: ActorContext, input: CorrectionInput): Promise<{ id: string; merged: boolean }> {
    const principal = actor.principal!;
    assertCan(principal, Permission.CORRECTIONS_MANAGE);
    const title = input.title ?? truncate(input.desired, 120);
    return this.db.transaction(async (tx) => {
      const agentId = await resolveAgent(tx, input);
      const [managed] = await tx.select({ id: virtualAgents.id }).from(virtualAgents).where(and(eq(virtualAgents.id, agentId), sql`${virtualAgents.id} IN (${manageableAgentsSql(principal)})`));
      if (!managed) throw input.conversationId ? notFound('conversation', input.conversationId) : notFound('agent', agentId);
      const [existing] = await tx
        .select({ id: promptCorrections.id })
        .from(promptCorrections)
        .where(
          and(
            eq(promptCorrections.agentId, agentId),
            eq(promptCorrections.componentKey, input.componentKey),
            inArray(promptCorrections.status, ['OPEN', 'STAGED']),
            sql`lower(${promptCorrections.title}) = lower(${title})`,
          ),
        )
        .for('update')
        .limit(1);
      if (existing) {
        await tx.update(promptCorrections).set({ occurrences: sql`${promptCorrections.occurrences} + 1`, updatedAt: new Date() }).where(eq(promptCorrections.id, existing.id));
        await recordAudit(tx, actor, { action: 'correction.observe', targetType: 'prompt_correction', targetId: existing.id, summary: `Observed again: ${title}`, after: { conversationId: input.conversationId ?? null, interactionSeq: input.interactionSeq ?? null } });
        return { id: existing.id, merged: true };
      }
      const id = uuidv7();
      await tx.insert(promptCorrections).values({
        id,
        agentId,
        conversationId: input.conversationId ?? null,
        interactionSeq: input.interactionSeq ?? null,
        title,
        observed: input.observed,
        desired: input.desired,
        componentKey: input.componentKey,
        proposedText: input.proposedText ?? null,
        source: principal.via === 'INTERNAL_AGENT' ? 'INTERNAL_AGENT' : 'LEAD',
        createdBy: principal.userId,
      });
      await recordAudit(tx, actor, { action: 'correction.create', targetType: 'prompt_correction', targetId: id, summary: `Correction for ${input.componentKey}: ${title}`, after: { ...input, title } });
      return { id, merged: false };
    });
  }

  /** Write the proposed text into the agent's prompt DRAFT component and mark the correction STAGED. */
  async stage(actor: ActorContext, id: string, input: StageCorrectionInput): Promise<{ componentKey: BusinessComponentKey; changed: boolean }> {
    assertCan(actor.principal!, Permission.CORRECTIONS_MANAGE);
    const row = await this.loadManaged(actor, id);
    if (row.status !== 'OPEN' && row.status !== 'STAGED') throw conflict('correction_not_open', `Correction is ${row.status}`);
    const text = input.proposedText ?? row.proposedText;
    if (!text) throw validation('proposed_text_required', 'Provide the text to stage into the prompt draft');
    const key = row.componentKey as BusinessComponentKey;
    const draft = await this.prompts.draft(actor.principal!, row.agentId);
    const components = Object.fromEntries(BUSINESS_COMPONENT_KEYS.map((k) => [k, draft.components[k] ?? ''])) as Record<BusinessComponentKey, string>;
    const before = components[key];
    components[key] = composeComponent(before, text, input.mode);
    // PromptService enforces prompts.edit and keeps the draft semantics (one draft per agent).
    await this.prompts.saveDraft(actor, row.agentId, components as PromptComponents);
    await this.db.transaction(async (tx) => {
      await tx.update(promptCorrections).set({ status: 'STAGED', proposedText: text, updatedAt: new Date() }).where(eq(promptCorrections.id, id));
      await recordAudit(tx, actor, {
        action: 'correction.stage',
        targetType: 'prompt_correction',
        targetId: id,
        summary: `Staged into ${key} draft (${input.mode.toLowerCase()}): ${row.title}`,
        before: { [key]: before },
        after: { [key]: components[key] },
      });
    });
    return { componentKey: key, changed: before !== components[key] };
  }

  async reject(actor: ActorContext, id: string, input: RejectCorrectionInput): Promise<void> {
    assertCan(actor.principal!, Permission.CORRECTIONS_MANAGE);
    await this.loadManaged(actor, id);
    await this.db.transaction(async (tx) => {
      const [row] = await tx.select().from(promptCorrections).where(eq(promptCorrections.id, id)).for('update');
      if (!row) throw notFound('prompt_correction', id);
      if (row.status !== 'OPEN' && row.status !== 'STAGED') throw conflict('correction_not_open', `Correction is ${row.status}`);
      await tx.update(promptCorrections).set({ status: 'REJECTED', updatedAt: new Date() }).where(eq(promptCorrections.id, id));
      await recordAudit(tx, actor, {
        action: 'correction.reject',
        targetType: 'prompt_correction',
        targetId: id,
        summary: `Rejected: ${row.title}${input.reason ? ` · ${input.reason}` : ''}${row.status === 'STAGED' ? ' (draft text left for the editor to review)' : ''}`,
      });
    });
  }

  /** A correction of an agent the actor's teams own; not found otherwise. */
  private async loadManaged(actor: ActorContext, id: string): Promise<CorrectionRow> {
    const [row] = await this.db
      .select()
      .from(promptCorrections)
      .where(and(eq(promptCorrections.id, id), sql`${promptCorrections.agentId} IN (${manageableAgentsSql(actor.principal!)})`));
    if (!row) throw notFound('prompt_correction', id);
    return row;
  }
}

export { markCorrectionsApplied } from './corrections-applied.js';

async function resolveAgent(tx: DbOrTx, input: CorrectionInput): Promise<string> {
  if (!input.conversationId) {
    const [agent] = await tx.select({ id: virtualAgents.id }).from(virtualAgents).where(eq(virtualAgents.id, input.agentId!));
    if (!agent) throw notFound('agent', input.agentId!);
    return agent.id;
  }
  const [conv] = await tx.select({ agentId: conversations.agentId }).from(conversations).where(eq(conversations.id, input.conversationId));
  if (!conv) throw notFound('conversation', input.conversationId);
  if (!conv.agentId) throw validation('conversation_routing', 'The conversation has no agent yet (a router is still deciding)');
  if (input.agentId && input.agentId !== conv.agentId) throw validation('agent_mismatch', 'The conversation belongs to a different agent');
  if (input.interactionSeq !== undefined) {
    const [turn] = await tx
      .select({ id: interactions.id })
      .from(interactions)
      .where(and(eq(interactions.conversationId, input.conversationId), eq(interactions.seq, input.interactionSeq)));
    if (!turn) throw validation('interaction_not_found', `No interaction ${input.interactionSeq} in this conversation`);
  }
  return conv.agentId;
}

const truncate = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

function view(c: CorrectionRow, agentName: string): CorrectionView {
  return { ...c, agentName, createdAt: c.createdAt.toISOString(), updatedAt: c.updatedAt.toISOString() };
}
