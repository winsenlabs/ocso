import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDefaultDeliveryRegistry } from '@ocso/alerts';
import { alertDeliveries, alertRules, alerts, approvalProposals, notificationDestinations, uuidv7 } from '@ocso/db';
import { MemoryQueue } from '@ocso/queue';
import { AlertRuleService, isApproved, seedDefaultAlertRules, type AlertRuleInput } from '../../src/index.js';
import { createBusinessFixture, type BusinessFixture } from './business-fixture.js';
import { act } from './fixture.js';

/**
 * Alert rules (PM/research/11 §4): two kinds over one table — `alert_rule`
 * (business: alert_rules.business.manage, checked with approvals.check.agents)
 * and `alert_rule_technical` (alert_rules.technical.manage, approvals.check.platform).
 * New rules are disabled drafts; on = ACTIVATE; off is immediate; changes to an
 * approved rule and deletions are proposals.
 */
let f: BusinessFixture;
let rules: AlertRuleService;
const queue = new MemoryQueue();
const routing = createDefaultDeliveryRegistry({ fetch: async () => new Response('') });

const business = (o: Partial<AlertRuleInput> = {}): AlertRuleInput => ({
  name: 'CSAT floor',
  kind: 'BUSINESS',
  condition: 'csat_below',
  params: {},
  agentId: null,
  windowSeconds: 3600,
  severity: 'WARNING',
  audienceRoles: ['HEAD'],
  destinationIds: [],
  dedupeWindowSeconds: 3600,
  autoResolve: true,
  enabled: true,
  ...o,
});

beforeAll(async () => {
  f = await createBusinessFixture();
  rules = new AlertRuleService(f.t.db, queue, routing);
});
afterAll(async () => {
  await f?.t.drop();
});

const ruleRow = async (id: string) => (await f.t.db.select().from(alertRules).where(eq(alertRules.id, id)))[0];

describe('business alert rules', () => {
  it('a new rule is a disabled draft, edited directly', async () => {
    const rule = await rules.create(act(f.p.lead), business({ agentId: f.maya }));
    expect(rule).toMatchObject({ enabled: false, approval: { approved: false, pending: null } });
    expect((await rules.update(act(f.p.lead), rule.id, { severity: 'CRITICAL' })).severity).toBe('CRITICAL');
    // Agent-scoped rules belong to the agent's teams: the Loans Head is not in scope.
    await expect(rules.get(act(f.p.headLoans), rule.id)).rejects.toMatchObject({ code: 'alert_rule_not_found' });
  });

  it('turning on is ACTIVATE (a Head checks); a change once approved is UPDATE; off is immediate while it waits', async () => {
    const rule = await rules.create(act(f.p.lead), business({ name: 'SLA breaches', condition: 'sla_breaches_above', agentId: f.maya }));
    expect(await rules.plan(act(f.p.lead), rule.id, { enabled: true })).toMatchObject({ kind: 'activate', objectKind: 'alert_rule' });
    const on = await f.propose(f.p.lead, f.p.head, { objectKind: 'alert_rule', objectId: rule.id, action: 'ACTIVATE' });
    expect(on.title).toBe('Turn on alert rule "SLA breaches"');
    await expect(rules.update(act(f.p.lead), rule.id, { severity: 'CRITICAL' })).rejects.toMatchObject({ code: 'approval_open' });
    await f.approveNow(f.p.head, on.id);
    expect((await ruleRow(rule.id))!.enabled).toBe(true);

    await expect(rules.update(act(f.p.lead), rule.id, { severity: 'CRITICAL' })).rejects.toMatchObject({ code: 'approval_required' });
    const change = await f.propose(f.p.lead, f.p.head2, { objectKind: 'alert_rule', objectId: rule.id, action: 'UPDATE', payload: { severity: 'CRITICAL', params: { threshold: 2 } } });
    // Stop while the change waits: immediate, never locked, does not void it.
    await rules.disable(act(f.p.lead), rule.id);
    await f.approveNow(f.p.head2, change.id);
    expect(await ruleRow(rule.id)).toMatchObject({ enabled: false, severity: 'CRITICAL', params: { threshold: 2 } });
    // The kind of an approved rule is fixed (it decides who checks).
    await expect(rules.plan(act(f.p.lead), rule.id, { kind: 'TECHNICAL' })).rejects.toMatchObject({ category: 'authorization' });
  });

  it('an approval re-validates: an invalid change is refused at submit', async () => {
    const rule = await rules.create(act(f.p.lead), business({ name: 'Bad params' }));
    await f.approveNow(f.p.head, (await f.propose(f.p.lead, f.p.head, { objectKind: 'alert_rule', objectId: rule.id, action: 'ACTIVATE' })).id);
    await expect(f.propose(f.p.lead, f.p.head, { objectKind: 'alert_rule', objectId: rule.id, action: 'UPDATE', payload: { params: { threshold: 99 } } })).rejects.toMatchObject({
      code: 'validation_failed',
    });
  });

  it('deleting is a proposal; the worker resolves the rule’s open alerts and notifies destinations', async () => {
    const destination = uuidv7();
    // A webhook destination receives RESOLVED (in-app ones only hear OPENED).
    await f.t.db.insert(notificationDestinations).values({ id: destination, name: 'Ops webhook', kind: 'WEBHOOK', config: { url: 'https://hooks.bank.test/alerts' } });
    const rule = await rules.create(act(f.p.lead), business({ name: 'To delete', destinationIds: [destination] }));
    const alertId = uuidv7();
    await f.t.db.insert(alerts).values({ id: alertId, ruleId: rule.id, fingerprint: `f-${alertId}`, kind: 'BUSINESS', severity: 'WARNING', title: 'CSAT low', body: 'b', audienceRoles: ['HEAD'], source: 's' });
    const p = await f.propose(f.p.lead, f.p.head, { objectKind: 'alert_rule', objectId: rule.id, action: 'DELETE' });
    const approved = await f.approveNow(f.p.head, p.id);
    expect(approved).toMatchObject({ status: 'APPROVED', activating: true });
    expect(await ruleRow(rule.id)).toBeDefined(); // not yet: the worker finishes it
    expect(await f.business.decisions.finishActivation(f.worker, p.id)).toBe('ACTIVATED');
    expect(await ruleRow(rule.id)).toBeUndefined();
    const [alert] = await f.t.db.select().from(alerts).where(eq(alerts.id, alertId));
    expect(alert).toMatchObject({ status: 'RESOLVED', resolution: 'Resolved: alert rule deleted' });
    const deliveries = await f.t.db.select().from(alertDeliveries).where(eq(alertDeliveries.alertId, alertId));
    expect(deliveries.map((d) => d.event)).toEqual(['RESOLVED']);
  });
});

describe('business alert rules — review fixes', () => {
  it('an approved DELETE stops the rule at once; a crash after the worker removed it finishes ACTIVATED, not BLOCKED', async () => {
    const rule = await rules.create(act(f.p.lead), business({ name: 'Crash delete', agentId: f.maya }));
    await f.approveNow(f.p.head, (await f.propose(f.p.lead, f.p.head, { objectKind: 'alert_rule', objectId: rule.id, action: 'ACTIVATE' })).id);
    const p = await f.propose(f.p.lead, f.p.head, { objectKind: 'alert_rule', objectId: rule.id, action: 'DELETE' });
    await f.approveNow(f.p.head, p.id);
    // The rule no longer fires while the worker has not run.
    expect((await ruleRow(rule.id))!.enabled).toBe(false);
    // The worker's removal committed, then it died before stamping the proposal.
    await f.t.db.delete(alertRules).where(eq(alertRules.id, rule.id));
    expect(await f.business.decisions.finishActivation(f.worker, p.id)).toBe('ACTIVATED');
    const [row] = await f.t.db.select().from(approvalProposals).where(eq(approvalProposals.id, p.id));
    expect(row).toMatchObject({ status: 'APPROVED' });
    expect(row!.activatedAt).not.toBeNull();
  });

  it("an UPDATE that moves a rule to another team's agent is scoped to the maker and shown to both teams", async () => {
    const loansAgent = (await f.agents.create(act(f.p.headLoans), { name: 'Lina', purpose: 'loans', conversationType: 'SUPPORT', description: '', modelProfileId: f.profile, teamIds: [f.team.loans] })).id;
    const rule = await rules.create(act(f.p.lead), business({ name: 'Retarget', agentId: f.maya }));
    await f.approveNow(f.p.head, (await f.propose(f.p.lead, f.p.head, { objectKind: 'alert_rule', objectId: rule.id, action: 'ACTIVATE' })).id);
    // The Cards Lead cannot read the Loans agent: the change is refused, as creating a rule there would be.
    await expect(f.propose(f.p.lead, f.p.head, { objectKind: 'alert_rule', objectId: rule.id, action: 'UPDATE', payload: { agentId: loansAgent } })).rejects.toMatchObject({ code: 'validation_failed' });
    // Such a change belongs to both agents' teams: the new owner sees it and may check it.
    const d = f.business.registry.get('alert_rule');
    expect(await d.teamIds(f.t.db, rule.id, { agentId: loansAgent })).toEqual([f.team.cards, f.team.loans].sort());
  });
});

describe('technical alert rules', () => {
  it('Tech makes them; a holder of approvals.check.platform checks; Leads cannot touch them', async () => {
    const rule = await rules.create(act(f.p.tech), business({ name: 'Workers low', kind: 'TECHNICAL', condition: 'workers_below_min', audienceRoles: ['TECH'] }));
    expect(await rules.plan(act(f.p.tech), rule.id, { enabled: true })).toMatchObject({ objectKind: 'alert_rule_technical' });
    // A business-kind proposal needs the business manage permission; a Head proposing it finds no such business rule.
    await expect(f.propose(f.p.tech, f.p.head, { objectKind: 'alert_rule', objectId: rule.id, action: 'ACTIVATE' })).rejects.toMatchObject({ category: 'authorization' });
    await expect(f.propose(f.p.head, f.p.head2, { objectKind: 'alert_rule', objectId: rule.id, action: 'ACTIVATE' })).rejects.toMatchObject({ category: 'not_found' });
    await expect(f.propose(f.p.lead, f.p.head, { objectKind: 'alert_rule_technical', objectId: rule.id, action: 'ACTIVATE' })).rejects.toMatchObject({ category: 'authorization' });
    const p = await f.propose(f.p.tech, f.p.head, { objectKind: 'alert_rule_technical', objectId: rule.id, action: 'ACTIVATE' });
    await f.approveNow(f.p.head, p.id);
    expect((await ruleRow(rule.id))!.enabled).toBe(true);
  });

  it('default rules installed at setup are recorded approved: nothing is live without an approval', async () => {
    const seeded = await seedDefaultAlertRules(f.t.db);
    expect(seeded.created.length).toBeGreaterThan(0);
    for (const kind of ['alert_rule', 'alert_rule_technical']) {
      for (const id of await f.business.registry.get(kind).liveObjects(f.t.db)) expect(await isApproved(f.t.db, kind, id), `${kind} ${id}`).toBe(true);
    }
    const installed = await f.t.db.select().from(approvalProposals).where(eq(approvalProposals.contentHash, 'ap_installed'));
    expect(installed.every((p) => p.origin === 'MIGRATION' && p.status === 'APPROVED' && p.activatedAt !== null && p.makerId === null)).toBe(true);
  });
});
