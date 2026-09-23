import { and, eq, inArray, sql } from 'drizzle-orm';
import { Permission } from '@ocso/auth';
import { promptVersions, virtualAgents, type DbOrTx } from '@ocso/db';
import { notFound } from '@ocso/domain';
import type { ApprovalDescriptor } from '../approvals/contract.js';
import { isApproved, lockObject } from '../approvals/guard.js';
import { assertAgentManageable, assertAgentReadable, owningTeams } from './access.js';
import { agentFamily, lockAgentConfig } from './approval-lock.js';
import { applyPromptActivation } from './prompt-versions.js';

/**
 * prompt_version ACTIVATE (PM/research/11 §4, 11b), checked with
 * approvals.check.agents. Gated by its agent's approval: a draft agent's prompt
 * activates directly. A version shares its agent's lock, and an open proposal on
 * the agent or on any of its versions locks all of them — one open prompt
 * activation per agent at a time.
 */

type Projection = Record<string, unknown>;

async function versionOf(tx: DbOrTx, versionId: string) {
  const [v] = await tx.select().from(promptVersions).where(eq(promptVersions.id, versionId));
  return v ?? null;
}

async function projectPrompt(tx: DbOrTx, agentId: string, activeId: string | null, name: string): Promise<Projection> {
  const active = activeId ? await versionOf(tx, activeId) : null;
  return {
    agent: name,
    activeVersion: active ? `v${active.version} · ${active.promptHash}` : null,
    components: active?.components ?? {},
    agentId,
  };
}

async function agentOf(tx: DbOrTx, versionId: string): Promise<string | null> {
  return (await versionOf(tx, versionId))?.agentId ?? null;
}

export const promptVersionApproval: ApprovalDescriptor = {
  kind: 'prompt_version',
  label: 'Prompt version',
  actions: ['ACTIVATE'],
  makePermission: () => Permission.PROMPTS_ACTIVATE,
  checkPermission: Permission.APPROVALS_CHECK_AGENTS,

  /** The agent's own approval gates its prompt: a draft agent activates prompts directly. */
  async requiresApproval(tx, versionId) {
    const agentId = await agentOf(tx, versionId);
    return agentId ? isApproved(tx, 'agent', agentId) : false;
  },
  async project(tx, versionId) {
    const v = await versionOf(tx, versionId);
    if (!v) return null;
    const [agent] = await tx.select({ name: virtualAgents.name, active: virtualAgents.activePromptVersionId }).from(virtualAgents).where(eq(virtualAgents.id, v.agentId));
    return agent ? projectPrompt(tx, v.agentId, agent.active, agent.name) : null;
  },
  async projectAfter(tx, p) {
    const v = await versionOf(tx, p.objectId);
    if (!v) return null;
    const [agent] = await tx.select({ name: virtualAgents.name }).from(virtualAgents).where(eq(virtualAgents.id, v.agentId));
    return projectPrompt(tx, v.agentId, v.id, agent?.name ?? 'agent');
  },
  /** Ids only: the agent and which version is active (the version rows themselves are immutable). */
  async hashBasis(tx, versionId) {
    const v = await versionOf(tx, versionId);
    if (!v) return null;
    const [agent] = await tx.select({ active: virtualAgents.activePromptVersionId }).from(virtualAgents).where(eq(virtualAgents.id, v.agentId));
    return agent ? { agentId: v.agentId, versionId: v.id, promptHash: v.promptHash, activeVersionId: agent.active } : null;
  },
  async lock(tx, versionId) {
    const agentId = await agentOf(tx, versionId);
    if (agentId) await lockAgentConfig(tx, agentId);
    else await lockObject(tx, `prompt_version:${versionId}`);
  },
  async related(tx, versionId) {
    const agentId = await agentOf(tx, versionId);
    return agentId ? agentFamily(tx, agentId) : [];
  },
  async teamIds(tx, versionId) {
    const agentId = await agentOf(tx, versionId);
    return agentId ? ((await owningTeams(tx, [agentId])).get(agentId) ?? []).map((t) => t.id) : [];
  },
  dependencies: async () => [],
  async assertVisible(tx, principal, versionId) {
    const agentId = await agentOf(tx, versionId);
    if (!agentId) throw notFound('prompt_version', versionId);
    await assertAgentReadable(tx, principal, agentId);
  },
  async assertMakeable(tx, principal, versionId) {
    const agentId = await agentOf(tx, versionId);
    if (!agentId) throw notFound('prompt_version', versionId);
    await assertAgentManageable(tx, principal, agentId);
  },
  async validate(tx, p) {
    const v = await versionOf(tx, p.objectId);
    if (!v) return [{ code: 'object_missing', message: 'The prompt version no longer exists.' }];
    const [agent] = await tx.select({ active: virtualAgents.activePromptVersionId }).from(virtualAgents).where(eq(virtualAgents.id, v.agentId));
    if (!agent) return [{ code: 'object_missing', message: 'The agent no longer exists.' }];
    return agent.active === v.id ? [{ code: 'already_active', message: `v${v.version} is already the active prompt.` }] : [];
  },
  async activate(tx, actor, p) {
    const v = await versionOf(tx, p.objectId);
    if (!v) throw notFound('prompt_version', p.objectId);
    await applyPromptActivation(tx, actor, v.agentId, v.id);
    return { kind: 'DONE' };
  },
  /**
   * Active prompts of live agents — except one an approved agent proposal showed its checker (a draft
   * agent's go-live approval covers the prompt it takes live: its after-snapshot names the version and hash).
   */
  async liveObjects(tx) {
    const rows = await tx
      .select({ id: virtualAgents.activePromptVersionId })
      .from(virtualAgents)
      .innerJoin(promptVersions, eq(promptVersions.id, virtualAgents.activePromptVersionId))
      .where(
        and(
          inArray(virtualAgents.status, ['LIVE', 'PAUSED']),
          sql`NOT EXISTS (SELECT 1 FROM approval_proposals ap WHERE ap.object_kind = 'agent' AND ap.object_id = ${virtualAgents.id} AND ap.status = 'APPROVED'
                AND ap.after_snapshot->>'activePrompt' = 'v' || ${promptVersions.version} || ' · ' || ${promptVersions.promptHash})`,
        ),
      );
    return rows.flatMap((r) => (r.id ? [r.id] : []));
  },
  title(p) {
    const after = p.afterSnapshot ?? {};
    return `Activate prompt ${String(after['activeVersion'] ?? '').split(' · ')[0] || 'version'} for ${String(after['agent'] ?? 'agent')}`;
  },
};
