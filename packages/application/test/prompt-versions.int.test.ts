import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from '@ocso/db/testing';
import { promptVersions, uuidv7, virtualAgents } from '@ocso/db';
import type { Principal } from '@ocso/auth';
import { AgentService, PromptService, readGenerations, type ActorContext } from '../src/index.js';
import { createTeam } from './support/ownership.js';

let t: TestDatabase;
let prompts: PromptService;
let agentId: string;
// Everyone is in the team that owns Maya (ADR-026); only the role decides who may edit.
const TEAM = uuidv7();
const person = (role: Principal['role'], name: string): ActorContext => ({ principal: { userId: uuidv7(), role, displayName: name, teamIds: [TEAM], via: 'UI' }, correlationId: 'c' });
const lead = person('HEAD', 'Anjali Rao');
const exec = person('SERVICE', 'Nikhil Menon');
const admin = person('TECH', 'Dev Admin');

beforeAll(async () => {
  t = await createTestDatabase();
  for (const a of [lead, exec, admin]) {
    await t.pool.query(`INSERT INTO users (id, email, name, role) VALUES ($1, $2, $3, $4)`, [a.principal!.userId, `${a.principal!.role}@x.test`, a.principal!.displayName, a.principal!.role]);
  }
  prompts = new PromptService(t.db);
  await createTeam(t.db, TEAM);
  agentId = (await new AgentService(t.db).create(lead, { name: 'Maya', purpose: 'customer support', conversationType: 'SUPPORT', description: '', teamIds: [TEAM] })).id;
});
afterAll(async () => {
  await t?.drop();
});

const activeVersionId = async () => (await t.db.select({ v: virtualAgents.activePromptVersionId }).from(virtualAgents).where(eq(virtualAgents.id, agentId)))[0]!.v;

describe('prompt versioning (docs/archive/specs/05 §2)', () => {
  it('starts every agent on an immutable, activated v1', async () => {
    const versions = await prompts.versions(lead.principal!, agentId);
    expect(versions.map((v) => v.version)).toEqual([1]);
    expect(await activeVersionId()).toBe(versions[0]!.id);
    expect(versions[0]!.promptHash).toMatch(/^pc_/);
  });

  it('versions a draft with author, reason and the changed components only', async () => {
    const draft = await prompts.draft(lead.principal!, agentId);
    expect(draft.dirty).toBe(false);
    await prompts.saveDraft(lead, agentId, { ...draft.components, behavior: 'Keep replies under 60 words.' });
    expect((await prompts.draft(lead.principal!, agentId)).dirty).toBe(true);
    const v2 = await prompts.createVersionFromDraft(lead, agentId, { reason: 'shorter replies' });
    expect(v2).toMatchObject({ version: 2, changedComponents: ['behavior'], reason: 'shorter replies', authorId: lead.principal!.userId, parentVersionId: await activeVersionId() });
    expect(v2.firstActivatedAt).toBeNull();
    // Creating a version does not activate it.
    expect(await activeVersionId()).not.toBe(v2.id);
    expect((await prompts.draft(lead.principal!, agentId)).dirty).toBe(false);
  });

  it('rejects a version with no changes and prompt edits from roles without the permission', async () => {
    const draft = await prompts.draft(lead.principal!, agentId);
    await prompts.saveDraft(lead, agentId, draft.components);
    await expect(prompts.createVersionFromDraft(lead, agentId, { reason: 'nothing' })).rejects.toMatchObject({ code: 'no_changes' });
    await prompts.discardDraft(lead, agentId);
    await expect(prompts.saveDraft(exec, agentId, draft.components)).rejects.toMatchObject({ category: 'authorization' });
    await expect(prompts.saveDraft(admin, agentId, draft.components)).rejects.toMatchObject({ category: 'authorization' });
  });

  it('activates, invalidates the agent cache generation, audits, and rolls back to an older version', async () => {
    const [v2, v1] = await prompts.versions(lead.principal!, agentId);
    const before = (await readGenerations(t.db, [`agent:${agentId}`]))[`agent:${agentId}`] ?? 0;
    await prompts.activate(lead, agentId, v2!.id);
    expect(await activeVersionId()).toBe(v2!.id);
    expect((await readGenerations(t.db, [`agent:${agentId}`]))[`agent:${agentId}`]).toBe(before + 1);
    const [activated] = await t.db.select().from(promptVersions).where(eq(promptVersions.id, v2!.id));
    expect(activated!.firstActivatedAt).not.toBeNull();

    expect(await prompts.diff(lead.principal!, agentId, v1!.id, v2!.id)).toEqual([{ key: 'behavior', before: expect.any(String), after: 'Keep replies under 60 words.' }]);

    await prompts.activate(lead, agentId, v1!.id);
    expect(await activeVersionId()).toBe(v1!.id);
    const { rows } = await t.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM audit_events WHERE action = 'prompt.activate' AND target_id = ${agentId}`);
    expect(rows[0]!.n).toBe(2);
    // Activated versions are immutable at the database level.
    await expect(t.db.execute(sql`UPDATE prompt_versions SET reason = 'edited' WHERE id = ${v2!.id}`)).rejects.toThrow();
  });
});
