import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { auditEvents, escalationRules, queueTeams, queues, uuidv7 } from '@ocso/db';
import { ESCALATION_RULE_KIND, EscalationRuleInput, EscalationRuleService } from '../../src/index.js';
import { createBusinessFixture, type BusinessFixture } from './business-fixture.js';
import { act } from './fixture.js';

/**
 * escalation_rule (PM/research/11 §4): created as a disabled draft and edited
 * freely; turning it on (and resuming it) is ACTIVATE; any change to an approved
 * rule is UPDATE; DELETE always needs a checker; turning it off is immediate.
 */
let f: BusinessFixture;
let rules: EscalationRuleService;

beforeAll(async () => {
  f = await createBusinessFixture();
  rules = new EscalationRuleService(f.t.db);
  await f.goLive(f.maya);
});
afterAll(async () => {
  await f?.t.drop();
});

const row = async (id: string) => (await f.t.db.select().from(escalationRules).where(eq(escalationRules.id, id)))[0];
const newRule = (name: string) => rules.create(act(f.p.lead), f.maya, EscalationRuleInput.parse({ name, trigger: 'POLICY', condition: { keywords: ['fraud'] }, enabled: true }));
const target = (objectId: string, action: 'ACTIVATE' | 'UPDATE' | 'DELETE', payload?: Record<string, unknown>) => ({ objectKind: ESCALATION_RULE_KIND, objectId, action, ...(payload ? { payload } : {}) });

describe('escalation rules under maker–checker', () => {
  it('creates a disabled draft (whatever the input said) and edits it directly', async () => {
    const rule = await newRule('Fraud words');
    expect(rule.enabled).toBe(false);
    const edited = await rules.update(act(f.p.lead), f.maya, rule.id, { priority: 'P1' });
    expect(edited.priority).toBe('P1');
    const listed = (await rules.list(f.p.service, f.maya)).find((r) => r.id === rule.id)!;
    expect(listed.approval).toEqual({ approved: false, pending: null });
  });

  it('turning it on is an ACTIVATE proposal; the first approval makes it live', async () => {
    const rule = await newRule('Chargeback');
    expect(await rules.plan(act(f.p.lead), f.maya, rule.id, { enabled: true })).toEqual({ kind: 'activate' });
    await expect(rules.plan(act(f.p.lead), f.maya, rule.id, { enabled: true, name: 'x' })).rejects.toMatchObject({ code: 'enabled_alone' });
    const p = await f.propose(f.p.lead, f.p.head, target(rule.id, 'ACTIVATE'));
    expect(p.title).toBe('Turn on escalation rule "Chargeback" for Maya');
    // The object is locked while the proposal is open.
    await expect(rules.update(act(f.p.lead), f.maya, rule.id, { name: 'Chargebacks' })).rejects.toMatchObject({ code: 'approval_open' });
    await f.approveNow(f.p.head, p.id);
    expect((await row(rule.id))!.enabled).toBe(true);
    // Approved: every change is now a proposal.
    await expect(rules.update(act(f.p.lead), f.maya, rule.id, { name: 'Chargebacks' })).rejects.toMatchObject({ code: 'approval_required' });
  });

  it('a change to an approved rule applies on approval; turning it off meanwhile is immediate and does not void it', async () => {
    const rule = await newRule('Legal threat');
    await f.approveNow(f.p.head, (await f.propose(f.p.lead, f.p.head, target(rule.id, 'ACTIVATE'))).id);
    const p = await f.propose(f.p.lead, f.p.head2, target(rule.id, 'UPDATE', { priority: 'P1', condition: { keywords: ['lawyer', 'court'] } }));
    // Stop action while the proposal is open: never locked.
    expect(await rules.plan(act(f.p.lead), f.maya, rule.id, { enabled: false })).toEqual({ kind: 'disable' });
    await rules.disable(act(f.p.lead), f.maya, rule.id);
    expect((await row(rule.id))!.enabled).toBe(false);
    await f.approveNow(f.p.head2, p.id);
    expect(await row(rule.id)).toMatchObject({ enabled: false, priority: 'P1', condition: { keywords: ['lawyer', 'court'] } });
    // Resuming a stopped rule is an ACTIVATE.
    await f.approveNow(f.p.head, (await f.propose(f.p.lead, f.p.head, target(rule.id, 'ACTIVATE'))).id);
    expect((await row(rule.id))!.enabled).toBe(true);
  });

  it('deleting always needs a checker, even for a draft', async () => {
    const rule = await newRule('Scratch');
    const p = await f.propose(f.p.lead, f.p.head, target(rule.id, 'DELETE'));
    expect(p.after).toBeNull();
    await f.approveNow(f.p.head, p.id);
    expect(await row(rule.id)).toBeUndefined();
  });

  it('waits while the agent’s own proposal (which shows its rules) is open', async () => {
    const rule = await newRule('Vulnerable customer');
    const agentChange = await f.propose(f.p.lead, f.p.head, { objectKind: 'agent', objectId: f.maya, action: 'UPDATE', payload: { purpose: 'Cards, EMI and fraud support' } });
    await expect(f.propose(f.p.lead, f.p.head, target(rule.id, 'ACTIVATE'))).rejects.toMatchObject({ code: 'approval_open' });
    await expect(rules.update(act(f.p.lead), f.maya, rule.id, { priority: 'P2' })).rejects.toMatchObject({ code: 'approval_open' });
    await f.business.approvals.withdraw(act(f.p.lead), agentChange.id, 'Not now');
  });

  it('only a Lead of an owning team proposes; checkers hold approvals.check.agents', async () => {
    const rule = await newRule('Proposers');
    await expect(f.propose(f.p.headLoans, f.p.head, target(rule.id, 'ACTIVATE'))).rejects.toMatchObject({ code: 'agent_not_found' });
    await expect(f.propose(f.p.lead, f.p.tech, target(rule.id, 'ACTIVATE'))).rejects.toMatchObject({ code: 'checker_not_eligible' });
  });

  it('live objects: exactly the agent rules that are on (platform-wide rules are not OCSO’s to approve)', async () => {
    const platformWide = uuidv7();
    await f.t.db.insert(escalationRules).values({ id: platformWide, agentId: null, name: 'Global fraud', trigger: 'POLICY', condition: {}, enabled: true });
    const d = f.business.registry.get(ESCALATION_RULE_KIND);
    const on = (await f.t.db.select({ id: escalationRules.id, agentId: escalationRules.agentId }).from(escalationRules).where(eq(escalationRules.enabled, true))).filter((r) => r.agentId).map((r) => r.id);
    expect((await d.liveObjects(f.t.db)).sort()).toEqual(on.sort());
    expect(await d.liveObjects(f.t.db)).not.toContain(platformWide);
  });

  it('turning off a rule that is already off changes and audits nothing', async () => {
    const rule = await newRule('Already off');
    await rules.disable(act(f.p.lead), f.maya, rule.id);
    const audited = await f.t.db.select().from(auditEvents).where(and(eq(auditEvents.action, 'escalation_rule.disable'), eq(auditEvents.targetId, rule.id)));
    expect(audited).toEqual([]);
  });

  it('the teams serving the target queue see (and may check) the rule that sends them conversations', async () => {
    const loansQueue = uuidv7();
    await f.t.db.insert(queues).values({ id: loansQueue, name: 'Loans desk', agentId: null });
    await f.t.db.insert(queueTeams).values({ queueId: loansQueue, teamId: f.team.loans });
    const rule = await newRule('To loans');
    const d = f.business.registry.get(ESCALATION_RULE_KIND);
    expect(await d.teamIds(f.t.db, rule.id, { targetQueueId: loansQueue })).toEqual([f.team.cards, f.team.loans].sort());
  });
});
