import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { MemoryQueue } from '@ocso/queue';
import {
  AgentInput,
  AgentOwnersInput,
  AgentService,
  AgentToolGrantService,
  EscalationRuleInput,
  EscalationRuleService,
  EvaluationRunInput,
  EvaluationRunService,
  PromptService,
  replaceOwners,
} from '../src/index.js';
import { actor, createOwnershipFixture, type OwnershipFixture } from './support/ownership-fixture.js';

/** Team-scoped virtual-agent ownership (ADR-026): who reads and manages which agent, and owner changes. */

let f: OwnershipFixture;
const notFound = { category: 'not_found' };
beforeAll(async () => {
  f = await createOwnershipFixture();
});
afterAll(async () => {
  await f?.t.drop();
});

const agents = () => new AgentService(f.t.db);
const names = async (who: keyof OwnershipFixture['p']) => (await agents().list(f.p[who])).map((a) => a.name);

describe('reading agents', () => {
  it('lists only the agents of the caller’s teams; the Tech admin reads every agent, orphans included', async () => {
    expect(await names('leadA')).toEqual(['Maya', 'Sana']);
    expect(await names('leadB')).toEqual(['Arjun', 'Sana']);
    expect(await names('admin')).toEqual(['Arjun', 'Legacy', 'Maya', 'Sana']);
    const shared = (await agents().list(f.p.leadB)).find((a) => a.name === 'Sana')!;
    expect(shared.teams.map((t) => t.name)).toEqual(['Cards', 'Loans']);
  });

  it('reports another team’s agent as not found (404), never forbidden', async () => {
    await expect(agents().get(f.p.leadB, f.agent.maya)).rejects.toMatchObject(notFound);
    await expect(agents().get(f.p.leadA, f.agent.orphan)).rejects.toMatchObject(notFound);
    expect((await agents().get(f.p.leadB, f.agent.shared)).teams).toHaveLength(2);
    expect((await agents().get(f.p.admin, f.agent.orphan)).teams).toEqual([]);
  });

  it('lets a Service member read their teams’ agents and agents that route to their queues, without manage rights', async () => {
    expect(await names('execA')).toEqual(['Maya', 'Sana']);
    // Maya is owned by Cards, but one of her escalation rules targets the Loans queue Meera works.
    expect(await names('execB')).toEqual(['Arjun', 'Maya', 'Sana']);
    await expect(agents().get(f.p.execB, f.agent.orphan)).rejects.toMatchObject(notFound);
    await expect(agents().update(actor(f.p.execB), f.agent.arjun, { purpose: 'x' })).rejects.toMatchObject({ category: 'authorization' });
  });
});

describe('managing agents', () => {
  it('requires at least one owning team, all of them the creating lead’s teams', async () => {
    expect(AgentInput.safeParse({ name: 'No owner', conversationType: 'SUPPORT' }).success).toBe(false);
    expect(AgentInput.safeParse({ name: 'No owner', conversationType: 'SUPPORT', teamIds: [] }).success).toBe(false);
    const foreign = AgentInput.parse({ name: 'Sneaky', conversationType: 'SUPPORT', teamIds: [f.team.loans] });
    await expect(agents().create(actor(f.p.leadA), foreign)).rejects.toMatchObject({ code: 'owner_team_not_member' });
    await expect(agents().create(actor(f.p.admin), AgentInput.parse({ name: 'Admin agent', conversationType: 'SUPPORT', teamIds: [f.team.cards] }))).rejects.toMatchObject({ category: 'authorization' });
  });

  it('refuses every agent-scoped write on another team’s agent with 404', async () => {
    const b = actor(f.p.leadB);
    const prompts = new PromptService(f.t.db);
    const rules = new EscalationRuleService(f.t.db);
    const draft = await prompts.draft(f.p.leadA, f.agent.maya);
    const [v1] = await prompts.versions(f.p.leadA, f.agent.maya);
    await expect(agents().update(b, f.agent.maya, { purpose: 'hijacked' })).rejects.toMatchObject(notFound);
    await expect(agents().setStatus(b, f.agent.maya, 'PAUSED')).rejects.toMatchObject(notFound);
    await expect(prompts.draft(f.p.leadB, f.agent.maya)).rejects.toMatchObject(notFound);
    await expect(prompts.versions(f.p.leadB, f.agent.maya)).rejects.toMatchObject(notFound);
    await expect(prompts.diff(f.p.leadB, f.agent.maya, v1!.id, v1!.id)).rejects.toMatchObject(notFound);
    await expect(prompts.saveDraft(b, f.agent.maya, draft.components)).rejects.toMatchObject(notFound);
    await expect(prompts.activate(b, f.agent.maya, v1!.id)).rejects.toMatchObject(notFound);
    await expect(rules.list(f.p.leadB, f.agent.maya)).rejects.toMatchObject(notFound);
    await expect(rules.create(b, f.agent.maya, EscalationRuleInput.parse({ name: 'x', trigger: 'RISK' }))).rejects.toMatchObject(notFound);
    // A rule is addressed through its own agent: Maya's rule is not found under Arjun.
    await expect(rules.disable(b, f.agent.arjun, f.mayaRule)).rejects.toMatchObject({ code: 'escalation_rule_not_found' });
    await expect(rules.update(b, f.agent.arjun, f.mayaRule, { name: 'renamed' })).rejects.toMatchObject({ code: 'escalation_rule_not_found' });
    await expect(rules.assertRuleOf(b, f.agent.arjun, f.mayaRule)).rejects.toMatchObject({ code: 'escalation_rule_not_found' });
    const grants = new AgentToolGrantService(f.t.db);
    await expect(grants.list(b, f.agent.maya)).rejects.toMatchObject(notFound);
    await expect(grants.set(b, f.agent.maya, { grants: [] })).rejects.toMatchObject(notFound);
    const evaluations = new EvaluationRunService(f.t.db, new MemoryQueue());
    await expect(evaluations.create(b, EvaluationRunInput.parse({ agentId: f.agent.maya }))).rejects.toMatchObject(notFound);
    await expect(evaluations.list(f.p.leadB, { agentId: f.agent.maya, limit: 5 })).rejects.toMatchObject(notFound);
    // The owning lead still can; a co-owning team's lead manages the shared agent.
    await prompts.saveDraft(actor(f.p.leadA), f.agent.maya, { ...draft.components, behavior: 'Owned edit.' });
    await agents().update(b, f.agent.shared, { purpose: 'shared desk (loans)' });
    expect((await grants.list(b, f.agent.shared)).tools).toEqual([]);
  });

  it('keeps the Tech admin out of business configuration', async () => {
    const admin = actor(f.p.admin);
    await expect(agents().update(admin, f.agent.maya, { purpose: 'x' })).rejects.toMatchObject({ category: 'authorization' });
    const draft = await new PromptService(f.t.db).draft(f.p.admin, f.agent.maya);
    await expect(new PromptService(f.t.db).saveDraft(admin, f.agent.maya, draft.components)).rejects.toMatchObject({ category: 'authorization' });
  });
});

describe('owning-team changes', () => {
  const owners = async (agentId: string) => (await agents().get(f.p.admin, agentId)).teams.map((t) => t.name);

  it('lets a lead change ownership only among their own teams', async () => {
    const a = actor(f.p.leadA);
    await expect(agents().setOwners(a, f.agent.maya, [f.team.cards, f.team.loans])).rejects.toMatchObject({ code: 'owner_team_not_member' });
    await expect(agents().update(a, f.agent.maya, { teamIds: [f.team.cards, f.team.loans] })).rejects.toMatchObject({ code: 'owner_team_not_member' });
    // Removing Loans' ownership of the shared agent is Loans' (or the Tech admin's) call.
    await expect(agents().setOwners(a, f.agent.shared, [f.team.cards])).rejects.toMatchObject({ code: 'owner_team_not_member' });
    await expect(agents().setOwners(actor(f.p.leadB), f.agent.maya, [f.team.loans])).rejects.toMatchObject(notFound);
    expect(AgentOwnersInput.safeParse({ teamIds: [] }).success).toBe(false);
    await expect(f.t.db.transaction((tx) => replaceOwners(tx, a, { id: f.agent.maya, name: 'Maya' }, [], 'OWN_TEAMS'))).rejects.toMatchObject({ code: 'owner_team_required' });
    expect(await owners(f.agent.maya)).toEqual(['Cards']);
  });

  it('allows a hand-off while another team still owns the agent; the lead then loses access', async () => {
    await agents().setOwners(actor(f.p.leadB), f.agent.shared, [f.team.cards]);
    expect(await owners(f.agent.shared)).toEqual(['Cards']);
    await expect(agents().get(f.p.leadB, f.agent.shared)).rejects.toMatchObject(notFound);
  });

  it('lets the Tech admin reassign any agent (orphans included), audited', async () => {
    const admin = actor(f.p.admin);
    const view = await agents().setOwners(admin, f.agent.orphan, [f.team.loans]);
    expect(view.teams.map((t) => t.name)).toEqual(['Loans']);
    expect(await names('leadB')).toEqual(['Arjun', 'Legacy']);
    await agents().setOwners(admin, f.agent.shared, [f.team.cards, f.team.loans]);
    await expect(agents().setOwners(admin, f.agent.maya, [crypto.randomUUID()])).rejects.toMatchObject({ code: 'unknown_team' });
    await expect(agents().setOwners(actor(f.p.execA), f.agent.maya, [f.team.cards])).rejects.toMatchObject({ category: 'authorization' });
    const { rows } = await f.t.db.execute<{ summary: string; actor_id: string }>(
      sql`SELECT summary, actor_id FROM audit_events WHERE action = 'agent.owners_change' AND target_id = ${f.agent.orphan}`,
    );
    expect(rows).toEqual([{ summary: 'Owning teams of Legacy: none → Loans (reassigned by Tech admin)', actor_id: f.p.admin.userId }]);
  });
});
