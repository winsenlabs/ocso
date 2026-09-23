import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { modelProfiles, virtualAgents } from '@ocso/db';
import { AgentToolGrantService, EscalationRuleService, PromptService, applyPromptActivation, createPromptVersion } from '../../src/index.js';
import { act, createApprovalFixture, type ApprovalFixture } from './fixture.js';

/**
 * One configuration, one lock (review of ADR-030): an agent and its prompt
 * versions lock each other while a proposal is open; its owners, tool grants
 * and escalation rules are locked too; and a decision reads the object under
 * the same lock the direct writes take, so nothing lands between the checks
 * and the activation.
 */
let f: ApprovalFixture;
let prompts: PromptService;
beforeAll(async () => {
  f = await createApprovalFixture();
  prompts = new PromptService(f.t.db);
});
afterAll(async () => {
  await f?.t.drop();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const components = (text: string) => ({ role: text, style: '', policy: '', escalation: '', knowledge: '', tools: '', examples: '' });

async function newVersion(agentId: string, text: string) {
  return f.t.db.transaction((tx) => createPromptVersion(tx, act(f.p.lead), { agentId, components: components(text) as never, reason: `v: ${text}`, parentVersionId: null }));
}

describe('an agent and its prompt versions lock each other', () => {
  it('while "Take X live" is open, a draft agent’s prompt cannot be activated directly, nor proposed', async () => {
    const agent = await f.newAgent('Locked Lara');
    const v2 = await newVersion(agent, 'second prompt');
    const open = await f.submit(f.p.lead, f.p.head, { objectId: agent, action: 'ACTIVATE' });
    await expect(prompts.activate(act(f.p.lead), agent, v2.id)).rejects.toMatchObject({ code: 'approval_open', details: { proposalId: open.id } });
    await expect(f.submit(f.p.lead, f.p.head, { objectKind: 'prompt_version', objectId: v2.id, action: 'ACTIVATE' })).rejects.toMatchObject({ code: 'approval_open' });
    await f.approvals.withdraw(act(f.p.lead), open.id, 'done');
    await expect(prompts.activate(act(f.p.lead), agent, v2.id)).resolves.toBeUndefined();
  });

  it('one open prompt activation per agent; it also locks the agent', async () => {
    const agent = await f.newAgent('Versioned Vera');
    await f.approve(f.p.head, (await f.submit(f.p.lead, f.p.head, { objectId: agent, action: 'ACTIVATE' })).id);
    const v2 = await newVersion(agent, 'v2');
    const v3 = await newVersion(agent, 'v3');
    const first = await f.submit(f.p.lead, f.p.head, { objectKind: 'prompt_version', objectId: v2.id, action: 'ACTIVATE' });
    await expect(f.submit(f.p.lead, f.p.head, { objectKind: 'prompt_version', objectId: v3.id, action: 'ACTIVATE' })).rejects.toMatchObject({ code: 'approval_open' });
    await expect(f.submit(f.p.lead, f.p.head, { objectId: agent, action: 'UPDATE', payload: { purpose: 'meanwhile' } })).rejects.toMatchObject({ code: 'approval_open' });
    await expect(f.agents.update(act(f.p.lead), agent, { purpose: 'direct' })).rejects.toMatchObject({ code: 'approval_open' });
    await expect(f.approve(f.p.head, first.id)).resolves.toMatchObject({ status: 'APPROVED' });
  });
});

describe('what the checker saw stays what goes live', () => {
  it('owners, tool grants and escalation rules are locked while an agent proposal is open', async () => {
    const agent = await f.newAgent('Guarded Gia');
    const open = await f.submit(f.p.lead, f.p.head, { objectId: agent, action: 'ACTIVATE' });
    await expect(f.agents.setOwners(act(f.p.lead), agent, [f.team.cards])).rejects.toMatchObject({ code: 'approval_open' });
    await expect(new AgentToolGrantService(f.t.db).set(act(f.p.lead), agent, { grants: [] })).rejects.toMatchObject({ code: 'approval_open' });
    const rules = new EscalationRuleService(f.t.db);
    await expect(rules.create(act(f.p.lead), agent, { name: 'Refunds', trigger: 'POLICY', condition: {}, mode: 'OPEN_PICKUP', targetQueueId: null, priority: 'P2', enabled: true })).rejects.toMatchObject({
      code: 'approval_open',
    });
    await f.approvals.withdraw(act(f.p.lead), open.id, 'done');
    await expect(rules.create(act(f.p.lead), agent, { name: 'Refunds', trigger: 'POLICY', condition: {}, mode: 'OPEN_PICKUP', targetQueueId: null, priority: 'P2', enabled: true })).resolves.toMatchObject({ name: 'Refunds' });
  });

  it('"Take X live" shows the checker the prompt text, the tools and the escalation rules going live', async () => {
    const agent = await f.newAgent('Shown Shira');
    await new EscalationRuleService(f.t.db).create(act(f.p.lead), agent, { name: 'Fraud', trigger: 'RISK', condition: {}, mode: 'OPEN_PICKUP', targetQueueId: null, priority: 'P1', enabled: true });
    const p = await f.submit(f.p.lead, f.p.head, { objectId: agent, action: 'ACTIVATE' });
    const shown = await f.approvals.get(f.p.head, p.id);
    expect(shown.after).toMatchObject({ status: 'LIVE', tools: [], escalationRules: ['Fraud (RISK)'] });
    expect(Object.keys((shown.after!['promptText'] ?? {}) as object).length).toBeGreaterThan(0);
    await f.approvals.withdraw(act(f.p.lead), p.id, 'done');
  });

  it('a write that commits while the decision waits for the lock voids the approval instead of going live unchecked', async () => {
    const agent = await f.newAgent('Raced Rhea');
    const v2 = await newVersion(agent, 'unchecked prompt');
    const p = await f.submit(f.p.lead, f.p.head, { objectId: agent, action: 'ACTIVATE' });
    const shown = await f.approvals.get(f.p.head, p.id);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    // A direct write (bypassing the guard, as a racing path would) holds the agent row…
    const writer = f.t.db.transaction(async (tx) => {
      await tx.select({ id: virtualAgents.id }).from(virtualAgents).where(eq(virtualAgents.id, agent)).for('update');
      await gate;
      await applyPromptActivation(tx, act(f.p.lead), agent, v2.id);
    });
    await sleep(50);
    // …the decision starts, waits for the object's lock, and must then see the new prompt.
    const decision = f.decisions.decide(act(f.p.head), p.id, { decision: 'APPROVE', contentHash: shown.contentHash });
    await sleep(150);
    release();
    await writer;
    await expect(decision).rejects.toMatchObject({ code: 'content_changed' });
    const [row] = await f.t.db.select({ status: virtualAgents.status }).from(virtualAgents).where(eq(virtualAgents.id, agent));
    expect(row!.status).toBe('DRAFT');
  });

  it('renaming something the agent points at does not void its open proposal (hashes cover ids, not names)', async () => {
    const agent = await f.newAgent('Named Nia');
    const p = await f.submit(f.p.lead, f.p.head, { objectId: agent, action: 'UPDATE', payload: { purpose: 'renamed deps' } });
    // Renamed behind the agent's back (name only; updated_at untouched so it is not a dependency change either).
    await f.t.db.update(modelProfiles).set({ name: 'support-renamed' }).where(eq(modelProfiles.id, f.profile));
    const shown = await f.approvals.get(f.p.head, p.id);
    expect(shown.warnings.map((w) => w.code)).not.toContain('content_changed');
    await expect(f.approve(f.p.head, p.id)).resolves.toMatchObject({ status: 'APPROVED' });
  });
});
