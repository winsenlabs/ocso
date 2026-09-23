import { eq } from 'drizzle-orm';
import { promptVersions, virtualAgents, type DbOrTx } from '@ocso/db';
import { assertUnlocked, lockObject } from '../approvals/guard.js';

/**
 * An agent and its prompt versions are one configuration for maker–checker:
 * one lock key (`agent:<id>`), and an open proposal on either locks both
 * (PM/research/11b "no third way for content to drift"). Kept apart from the
 * descriptors so the agent's other write paths (owners, tool grants,
 * escalation rules) can take the same lock without an import cycle.
 */

/** The advisory key every approval step for this agent takes, then the agent row itself (direct writes lock the row). */
export async function lockAgentConfig(tx: DbOrTx, agentId: string): Promise<void> {
  await lockObject(tx, `agent:${agentId}`);
  await tx.select({ id: virtualAgents.id }).from(virtualAgents).where(eq(virtualAgents.id, agentId)).for('update');
}

/** The agent itself and every one of its prompt versions. */
export async function agentFamily(tx: DbOrTx, agentId: string): Promise<Array<{ kind: string; objectIds: string[] }>> {
  const versions = await tx.select({ id: promptVersions.id }).from(promptVersions).where(eq(promptVersions.agentId, agentId));
  return [
    { kind: 'agent', objectIds: [agentId] },
    { kind: 'prompt_version', objectIds: versions.map((v) => v.id) },
  ];
}

/** 409 approval_open while a proposal on the agent or any of its prompt versions is open (or activating). */
export async function assertAgentUnlocked(tx: DbOrTx, agentId: string): Promise<void> {
  await assertUnlocked(tx, { kind: 'agent', related: agentFamily }, agentId);
}
