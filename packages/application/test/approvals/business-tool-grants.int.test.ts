import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { agentToolGrants, auditEvents, virtualAgents } from '@ocso/db';
import { AgentToolGrantService, TOOL_GRANT_KIND, grantDelta } from '../../src/index.js';
import { createBusinessFixture, type BusinessFixture } from './business-fixture.js';
import { act } from './fixture.js';

/**
 * agent_tool_grant (PM/research/11 §4, 11b): a draft agent's grants are written
 * directly; once the agent is approved, what widens access is a proposal while
 * removals and narrowing apply at once — even while that proposal is open.
 */
let f: BusinessFixture;
let grants: AgentToolGrantService;
const rule = { path: 'amountMinor', op: 'gt' as const, value: 500000, effect: 'REQUIRE_CONFIRMATION' as const, message: 'Large reversal' };

beforeAll(async () => {
  f = await createBusinessFixture();
  grants = new AgentToolGrantService(f.t.db);
});
afterAll(async () => {
  await f?.t.drop();
});

const stored = async (agentId: string) => (await f.t.db.select().from(agentToolGrants).where(eq(agentToolGrants.agentId, agentId))).map((g) => g.toolId).sort();

describe('grant delta', () => {
  it('splits removals, narrowing and widening', () => {
    const before = [
      { toolId: 'a', enabled: true, alwaysConfirm: false, argumentRules: [] },
      { toolId: 'b', enabled: true, alwaysConfirm: false, argumentRules: [rule] },
      { toolId: 'c', enabled: false, alwaysConfirm: true, argumentRules: [] },
    ];
    const next = [
      { toolId: 'b', enabled: true, alwaysConfirm: true, argumentRules: [rule, { ...rule, op: 'lt' as const }] }, // narrower
      { toolId: 'c', enabled: true, alwaysConfirm: true, argumentRules: [] }, // turned on: wider
      { toolId: 'd', enabled: true, alwaysConfirm: false, argumentRules: [] }, // new
    ];
    const d = grantDelta(before, next);
    expect(d.removed).toEqual(['a']);
    expect(d.narrowed.map((g) => g.toolId)).toEqual(['b']);
    expect(d.widened.map((g) => g.toolId)).toEqual(['c', 'd']);
    // Dropping a rule or the confirmation widens.
    expect(grantDelta([before[1]!], [{ ...before[1]!, argumentRules: [] }]).widened).toHaveLength(1);
    expect(grantDelta([before[2]!], [{ ...before[2]!, alwaysConfirm: false }]).widened).toHaveLength(1);
  });
});

describe('agent tool grants under maker–checker', () => {
  it('writes a draft agent’s grants directly (inert until the agent goes live)', async () => {
    const draft = await f.newAgent('Draft Dev');
    const change = await grants.replace(act(f.p.lead), draft, { grants: [{ toolId: f.toolIds.search }, { toolId: f.toolIds.reverse, argumentRules: [rule] }] });
    expect(change.proposed).toBeNull();
    expect(await stored(draft)).toEqual([f.toolIds.search, f.toolIds.reverse].sort());
  });

  it('once the agent is approved, an addition is a proposal; approval applies exactly it', async () => {
    await grants.replace(act(f.p.lead), f.maya, { grants: [{ toolId: f.toolIds.search }] });
    await f.goLive(f.maya);
    const change = await grants.replace(act(f.p.lead), f.maya, { grants: [{ toolId: f.toolIds.search }, { toolId: f.toolIds.reverse, argumentRules: [rule] }] });
    expect(change.proposed?.map((g) => g.toolId)).toEqual([f.toolIds.reverse]);
    expect(await stored(f.maya)).toEqual([f.toolIds.search]);
    // Callers that cannot route a proposal get 409 approval_required.
    await expect(grants.set(act(f.p.lead), f.maya, { grants: [{ toolId: f.toolIds.search }, { toolId: f.toolIds.reverse }] })).rejects.toMatchObject({ code: 'approval_required' });

    const p = await f.propose(f.p.lead, f.p.head, { objectKind: TOOL_GRANT_KIND, objectId: f.maya, action: 'UPDATE', payload: { grants: change.proposed! } });
    expect(p.title).toMatch(/Maya's tools/);
    expect(p.after).toMatchObject({ tools: { 'Core banking · payments.reverse': { enabled: true, argumentRules: [expect.stringContaining('amountMinor gt 500000')] } } });
    // The checker is never the maker; the approval applies it.
    await expect(f.approveNow(f.p.lead, p.id)).rejects.toMatchObject({ category: 'authorization' });
    const approved = await f.approveNow(f.p.head, p.id);
    expect(approved.status).toBe('APPROVED');
    expect(await stored(f.maya)).toEqual([f.toolIds.search, f.toolIds.reverse].sort());
  });

  it('a removal applies at once while an addition waits, and the waiting proposal must be refreshed', async () => {
    const change = await grants.replace(act(f.p.lead), f.maya, {
      grants: [{ toolId: f.toolIds.search }, { toolId: f.toolIds.reverse, argumentRules: [rule] }, { toolId: f.toolIds.lookup }],
    });
    const p = await f.propose(f.p.lead, f.p.head, { objectKind: TOOL_GRANT_KIND, objectId: f.maya, action: 'UPDATE', payload: { grants: change.proposed! } });
    // Stop action: remove search while the lookup addition is open — never locked.
    const removal = await grants.replace(act(f.p.lead), f.maya, { grants: [{ toolId: f.toolIds.reverse, argumentRules: [rule] }] });
    expect(removal.applied.removed).toEqual([f.toolIds.search]);
    expect(await stored(f.maya)).toEqual([f.toolIds.reverse]);
    // Each revocation has its own audit row (11b), apart from other tool changes.
    const revoked = await f.t.db.select().from(auditEvents).where(and(eq(auditEvents.action, 'agent_tool_grant.revoke'), eq(auditEvents.targetId, f.maya)));
    expect(revoked.map((a) => (a.after as { toolId: string }).toolId)).toEqual([f.toolIds.search]);
    // A second widening while one is open: one proposal per object.
    await expect(f.propose(f.p.lead, f.p.head, { objectKind: TOOL_GRANT_KIND, objectId: f.maya, action: 'UPDATE', payload: { grants: [{ toolId: f.toolIds.search }] } })).rejects.toMatchObject({
      code: 'approval_open',
    });
    // What the checker saw no longer holds: refused, until the maker refreshes the proposal.
    await expect(f.approveNow(f.p.head, p.id)).rejects.toMatchObject({ code: 'content_changed' });
    await f.business.approvals.edit(act(f.p.lead), p.id, { payload: { grants: change.proposed! } });
    await f.approveNow(f.p.head, p.id);
    expect(await stored(f.maya)).toEqual([f.toolIds.reverse, f.toolIds.lookup].sort());
  });

  it('narrowing (confirmation on) applies at once; dropping a rule is a widening proposal', async () => {
    const narrowed = await grants.replace(act(f.p.lead), f.maya, {
      grants: [{ toolId: f.toolIds.reverse, alwaysConfirm: true, argumentRules: [rule] }, { toolId: f.toolIds.lookup }],
    });
    expect(narrowed).toMatchObject({ proposed: null, applied: { narrowed: [f.toolIds.reverse] } });
    const [row] = await f.t.db.select().from(agentToolGrants).where(and(eq(agentToolGrants.agentId, f.maya), eq(agentToolGrants.toolId, f.toolIds.reverse)));
    expect(row!.alwaysConfirm).toBe(true);
    const loosen = await grants.replace(act(f.p.lead), f.maya, { grants: [{ toolId: f.toolIds.reverse, alwaysConfirm: true }, { toolId: f.toolIds.lookup }] });
    expect(loosen.proposed?.map((g) => g.toolId)).toEqual([f.toolIds.reverse]);
  });

  it('refuses a tool that is not grantable, at the proposal as at the draft', async () => {
    await expect(f.propose(f.p.lead, f.p.head, { objectKind: TOOL_GRANT_KIND, objectId: f.maya, action: 'UPDATE', payload: { grants: [{ toolId: f.maya }] } })).rejects.toMatchObject({
      code: 'validation_failed',
    });
  });

  it('live objects: a live agent’s grants that no approval covers', async () => {
    const d = f.business.registry.get(TOOL_GRANT_KIND);
    expect(await d.liveObjects(f.t.db)).toEqual([]);
    // An agent made live behind the spine's back, with a grant: reported.
    const rogue = await f.newAgent('Rogue');
    await f.t.db.insert(agentToolGrants).values({ agentId: rogue, toolId: f.toolIds.search });
    await f.t.db.update(virtualAgents).set({ status: 'LIVE' }).where(eq(virtualAgents.id, rogue));
    expect(await d.liveObjects(f.t.db)).toEqual([rogue]);
  });
});
