import { and, desc, eq, max } from 'drizzle-orm';
import { Permission, assertCan, type Principal } from '@ocso/auth';
import { notFound, validation } from '@ocso/domain';
import { promptDrafts, promptVersions, virtualAgents, uuidv7, type Db, type DbOrTx } from '@ocso/db';
import {
  BUSINESS_COMPONENT_KEYS,
  RUNTIME_CONTRACT_VERSION,
  changedComponents,
  contentHash,
  promptVersionHash,
  type BusinessComponentKey,
  type PromptComponents,
} from '@ocso/prompt-compiler';
import { z } from 'zod';
import { recordAudit } from '../audit/audit.js';
import { bumpGeneration } from '../cache/generations.js';
import { emitEvent } from '../events/outbox.js';
import type { ActorContext } from '../shared/context.js';
import { markCorrectionsApplied } from '../quality/corrections-applied.js';
import { assertAgentManageable, assertAgentReadable } from './access.js';

export const ComponentsInput = z.object(
  Object.fromEntries(BUSINESS_COMPONENT_KEYS.map((k) => [k, z.string().max(20_000)])) as Record<BusinessComponentKey, z.ZodString>,
);
export const CreateVersionInput = z.object({
  reason: z.string().trim().min(3).max(500),
  correctionIds: z.array(z.uuid()).max(50).optional(),
});
export type CreateVersionInput = z.infer<typeof CreateVersionInput>;

export type PromptVersionRow = typeof promptVersions.$inferSelect;

/** Insert an immutable version (docs/05 §2): author, time, reason, component diff and hashes. */
export async function createPromptVersion(
  tx: DbOrTx,
  actor: ActorContext,
  input: { agentId: string; components: PromptComponents; reason: string; parentVersionId: string | null; correctionIds?: string[] | undefined },
): Promise<PromptVersionRow> {
  const [latest] = await tx.select({ v: max(promptVersions.version) }).from(promptVersions).where(eq(promptVersions.agentId, input.agentId));
  const parent = input.parentVersionId
    ? (await tx.select().from(promptVersions).where(eq(promptVersions.id, input.parentVersionId)))[0]
    : undefined;
  const parentComponents = (parent?.components ?? {}) as PromptComponents;
  const changed = parent ? changedComponents(parentComponents, input.components) : [...BUSINESS_COMPONENT_KEYS];
  if (parent && changed.length === 0) throw validation('no_changes', 'No component changed since the parent version');
  const [row] = await tx
    .insert(promptVersions)
    .values({
      id: uuidv7(),
      agentId: input.agentId,
      version: (latest?.v ?? 0) + 1,
      components: input.components,
      componentHashes: Object.fromEntries(BUSINESS_COMPONENT_KEYS.map((k) => [k, contentHash(input.components[k] ?? '', 'c')])),
      promptHash: promptVersionHash(input.components),
      runtimeContractVersion: RUNTIME_CONTRACT_VERSION,
      changedComponents: changed,
      parentVersionId: input.parentVersionId,
      reason: input.reason,
      authorId: actor.principal?.userId ?? null,
      correctionIds: input.correctionIds ?? null,
    })
    .returning();
  await recordAudit(tx, actor, {
    action: 'prompt.version_create',
    targetType: 'prompt_version',
    targetId: row!.id,
    summary: `v${row!.version}: ${input.reason} (${changed.join(', ')})`,
  });
  return row!;
}

/**
 * Prompt drafts, versions, activation and diffs (design/02 Prompt + Versions tabs).
 * Reads need a readable agent, writes a managed one (owning team, ADR-026); both 404 otherwise.
 */
export class PromptService {
  constructor(private readonly db: Db) {}

  private async canEdit(actor: ActorContext, permission: Permission, agentId: string): Promise<void> {
    assertCan(actor.principal!, permission);
    await assertAgentManageable(this.db, actor.principal!, agentId);
  }

  async versions(principal: Principal, agentId: string): Promise<PromptVersionRow[]> {
    await assertAgentReadable(this.db, principal, agentId);
    return this.db.select().from(promptVersions).where(eq(promptVersions.agentId, agentId)).orderBy(desc(promptVersions.version));
  }

  async draft(principal: Principal, agentId: string): Promise<{ components: PromptComponents; baseVersionId: string | null; dirty: boolean }> {
    await assertAgentReadable(this.db, principal, agentId);
    const [agent] = await this.db.select().from(virtualAgents).where(eq(virtualAgents.id, agentId));
    if (!agent) throw notFound('agent', agentId);
    const [draft] = await this.db.select().from(promptDrafts).where(eq(promptDrafts.agentId, agentId));
    const [active] = agent.activePromptVersionId
      ? await this.db.select().from(promptVersions).where(eq(promptVersions.id, agent.activePromptVersionId))
      : [];
    const base = (active?.components ?? {}) as PromptComponents;
    if (!draft) return { components: base, baseVersionId: active?.id ?? null, dirty: false };
    const components = draft.components as PromptComponents;
    return { components, baseVersionId: draft.baseVersionId, dirty: changedComponents(base, components).length > 0 };
  }

  async saveDraft(actor: ActorContext, agentId: string, components: PromptComponents): Promise<void> {
    await this.canEdit(actor, Permission.PROMPTS_EDIT, agentId);
    const [agent] = await this.db.select().from(virtualAgents).where(eq(virtualAgents.id, agentId));
    if (!agent) throw notFound('agent', agentId);
    await this.db
      .insert(promptDrafts)
      .values({ agentId, components, baseVersionId: agent.activePromptVersionId, updatedBy: actor.principal!.userId })
      .onConflictDoUpdate({ target: promptDrafts.agentId, set: { components, updatedBy: actor.principal!.userId, updatedAt: new Date() } });
  }

  async createVersionFromDraft(actor: ActorContext, agentId: string, input: CreateVersionInput): Promise<PromptVersionRow> {
    await this.canEdit(actor, Permission.PROMPTS_EDIT, agentId);
    return this.db.transaction(async (tx) => {
      const [draft] = await tx.select().from(promptDrafts).where(eq(promptDrafts.agentId, agentId)).for('update');
      if (!draft) throw validation('no_draft', 'There is no draft to version');
      const [agent] = await tx.select().from(virtualAgents).where(eq(virtualAgents.id, agentId));
      const version = await createPromptVersion(tx, actor, {
        agentId,
        components: draft.components as PromptComponents,
        reason: input.reason,
        parentVersionId: agent?.activePromptVersionId ?? null,
        correctionIds: input.correctionIds,
      });
      // Corrections that motivated this version leave the review queue (design/02 Corrections tab).
      if (input.correctionIds?.length) await markCorrectionsApplied(tx, version.id);
      await tx.delete(promptDrafts).where(eq(promptDrafts.agentId, agentId));
      return version;
    });
  }

  async discardDraft(actor: ActorContext, agentId: string): Promise<void> {
    await this.canEdit(actor, Permission.PROMPTS_EDIT, agentId);
    await this.db.delete(promptDrafts).where(eq(promptDrafts.agentId, agentId));
  }

  /** Activation (or rollback to an older version). Invalidates the agent's derived caches. */
  async activate(actor: ActorContext, agentId: string, versionId: string): Promise<void> {
    await this.canEdit(actor, Permission.PROMPTS_ACTIVATE, agentId);
    await this.db.transaction(async (tx) => {
      const [version] = await tx.select().from(promptVersions).where(and(eq(promptVersions.id, versionId), eq(promptVersions.agentId, agentId)));
      if (!version) throw notFound('prompt_version', versionId);
      const [agent] = await tx.select().from(virtualAgents).where(eq(virtualAgents.id, agentId)).for('update');
      const previous = agent?.activePromptVersionId ?? null;
      await tx.update(virtualAgents).set({ activePromptVersionId: versionId, updatedAt: new Date() }).where(eq(virtualAgents.id, agentId));
      if (!version.firstActivatedAt) await tx.update(promptVersions).set({ firstActivatedAt: new Date() }).where(eq(promptVersions.id, versionId));
      await recordAudit(tx, actor, {
        action: 'prompt.activate',
        targetType: 'agent',
        targetId: agentId,
        summary: `Activated prompt v${version.version} (${version.promptHash})`,
        before: { activePromptVersionId: previous },
        after: { activePromptVersionId: versionId },
      });
      await bumpGeneration(tx, actor.correlationId, `agent:${agentId}`, 'prompt_activated');
      await emitEvent(tx, actor, 'config.changed', { area: 'prompt', entityId: versionId }, { agentId });
    });
  }

  async diff(principal: Principal, agentId: string, fromId: string, toId: string): Promise<Array<{ key: string; before: string; after: string }>> {
    await assertAgentReadable(this.db, principal, agentId);
    const [from] = await this.db.select().from(promptVersions).where(and(eq(promptVersions.id, fromId), eq(promptVersions.agentId, agentId)));
    const [to] = await this.db.select().from(promptVersions).where(and(eq(promptVersions.id, toId), eq(promptVersions.agentId, agentId)));
    if (!from || !to) throw notFound('prompt_version', !from ? fromId : toId);
    const a = from.components as PromptComponents;
    const b = to.components as PromptComponents;
    return changedComponents(a, b).map((key) => ({ key, before: a[key] ?? '', after: b[key] ?? '' }));
  }
}
