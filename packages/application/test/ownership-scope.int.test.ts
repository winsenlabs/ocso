import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { alertRules, alerts, uuidv7 } from '@ocso/db';
import { MemoryQueue } from '@ocso/queue';
import {
  AgentAnalyticsService,
  AlertRuleInput,
  AlertRuleService,
  AlertService,
  CorrectionService,
  CustomerService,
  HomeService,
  InboxService,
  QueueAnalyticsService,
  ReviewService,
  agentComparison,
  assertConversationAccess,
  tagSuggestions,
} from '../src/index.js';
import { actor, createOwnershipFixture, type OwnershipFixture } from './support/ownership-fixture.js';

/**
 * Everything agent-scoped follows the agent's owning teams (ADR-026):
 * conversations, customers, analytics, quality and alerts. Fixture: Maya is
 * Cards' (lead A), Arjun is Loans' (lead B), Sana is shared; c2 is Maya's but
 * routed to the Loans queue.
 */

let f: OwnershipFixture;
const policy = { execsCanViewAiActive: false };
const notFound = { category: 'not_found' };
beforeAll(async () => {
  f = await createOwnershipFixture();
});
afterAll(async () => {
  await f?.t.drop();
});

describe('conversation visibility', () => {
  const inbox = async (who: keyof OwnershipFixture['p']) => (await new InboxService(f.t.db).list(f.p[who], policy, { view: 'all', limit: 50 })).items.map((i) => i.id).sort();

  it('shows a lead the conversations of their teams’ agents plus those routed to their teams’ queues', async () => {
    expect(await inbox('leadA')).toEqual([f.conv.c1, f.conv.c2].sort());
    // c2 is Maya's (Cards) but waits in the Loans queue, so Loans' lead sees it; c1 (Maya, no queue) stays hidden.
    expect(await inbox('leadB')).toEqual([f.conv.c2, f.conv.c3].sort());
    await expect(assertConversationAccess(f.t.db, f.p.leadB, f.conv.c1, policy)).rejects.toMatchObject({ category: 'authorization' });
    await assertConversationAccess(f.t.db, f.p.leadB, f.conv.c2, policy);
  });

  it('keeps the exec scope unchanged: assigned, or their teams’ queues (AI-active only when allowed)', async () => {
    expect(await inbox('execB')).toEqual([f.conv.c2, f.conv.c3].sort());
    expect(await inbox('execA')).toEqual([]);
    expect(await inbox('admin')).toEqual([]);
  });

  it('scopes customers and tag suggestions to visible conversations', async () => {
    const customers = new CustomerService(f.t.db);
    await expect(customers.get(f.p.leadB, policy, f.customer.c1)).rejects.toMatchObject({ category: 'authorization' });
    expect((await customers.get(f.p.leadA, policy, f.customer.c1)).conversations.map((c) => c.id)).toEqual([f.conv.c1]);
    expect((await customers.search(f.p.leadB, policy, { limit: 50 })).map((c) => c.displayName).sort()).toEqual(['Farida Sheikh', 'Nandini Shah']);
    await expect(customers.update(actor(f.p.leadB), f.customer.c1, { language: 'hi' }, policy)).rejects.toMatchObject(notFound);
    const tags = async (who: 'leadA' | 'leadB') => (await tagSuggestions(f.t.db, f.p[who], policy, { limit: 10 })).items.map((i) => i.tag).sort();
    expect(await tags('leadA')).toEqual(['loan', 'vip']);
    expect(await tags('leadB')).toEqual(['loan']);
  });
});

describe('analytics', () => {
  const analytics = () => new AgentAnalyticsService(f.t.db);

  it('404s another team’s agent and aggregates only the lead’s agents', async () => {
    await expect(analytics().analytics(f.p.leadB, f.agent.maya, 7)).rejects.toMatchObject(notFound);
    expect((await analytics().analytics(f.p.leadA, f.agent.maya, 7)).tiles.conversations.value).toBe(2);
    expect((await analytics().analytics(f.p.leadB, null, 7)).tiles.conversations.value).toBe(1);
    expect((await analytics().analytics(f.p.leadA, null, 7)).tiles.conversations.value).toBe(2);
    const comparison = await agentComparison(f.t.db, f.p.leadB, 7);
    expect(comparison.agents.map((a) => a.name)).toEqual(['Arjun', 'Sana']);
  });

  it('scopes the queue table and the lead home', async () => {
    const queues = await new QueueAnalyticsService(f.t.db).list(f.p.leadA, 7);
    // Cards (served by team Cards) and Loans (Maya routes there).
    expect(queues.queues.map((q) => q.name).sort()).toEqual(['Cards & EMI', 'Loans desk']);
    const home = await new HomeService(f.t.db).home(f.p.leadB);
    if (home.role !== 'CS_LEAD') throw new Error('expected the lead home');
    expect(home.lead.agents.map((a) => a.name)).toEqual(['Arjun', 'Sana']);
    expect(home.lead.tiles.conversations).toBe(1);
    expect(home.lead.queues.map((q) => q.name)).toEqual(['Loans desk']);
  });
});

describe('quality', () => {
  it('scopes reviews and corrections to the lead’s agents', async () => {
    const reviews = new ReviewService(f.t.db);
    const rubric = { accuracy: 4, policy: 4, tone: 4, resolution: 4 };
    await expect(reviews.create(actor(f.p.leadB), { conversationId: f.conv.c2, rubric, outcomeTag: 'x' })).rejects.toMatchObject({ code: 'conversation_not_found' });
    await reviews.create(actor(f.p.leadA), { conversationId: f.conv.c2, rubric, outcomeTag: 'good handoff' });
    expect(await reviews.list(f.p.leadB, { limit: 50 })).toEqual([]);
    await expect(reviews.list(f.p.leadB, { agentId: f.agent.maya, limit: 50 })).rejects.toMatchObject(notFound);
    expect(await reviews.list(f.p.leadA, { agentId: f.agent.maya, limit: 50 })).toHaveLength(1);

    const corrections = new CorrectionService(f.t.db);
    const input = { observed: 'too long', desired: 'shorter', componentKey: 'behavior' as const };
    await expect(corrections.create(actor(f.p.leadB), { ...input, agentId: f.agent.maya })).rejects.toMatchObject(notFound);
    await expect(corrections.create(actor(f.p.leadB), { ...input, conversationId: f.conv.c2 })).rejects.toMatchObject({ code: 'conversation_not_found' });
    const { id } = await corrections.create(actor(f.p.leadA), { ...input, agentId: f.agent.maya });
    await expect(corrections.get(f.p.leadB, id)).rejects.toMatchObject(notFound);
    await expect(corrections.stage(actor(f.p.leadB), id, { mode: 'APPEND', proposedText: 'x' })).rejects.toMatchObject(notFound);
    await expect(corrections.reject(actor(f.p.leadB), id, {})).rejects.toMatchObject(notFound);
    expect(await corrections.list(f.p.leadB, { limit: 50 })).toEqual([]);
    await expect(corrections.list(f.p.leadB, { agentId: f.agent.maya, limit: 50 })).rejects.toMatchObject(notFound);
    expect((await corrections.list(f.p.leadA, { limit: 50 })).map((c) => c.id)).toEqual([id]);
  });
});

describe('alerts', () => {
  const ids = { maya: uuidv7(), none: uuidv7(), arjun: uuidv7() };
  const queue = new MemoryQueue();

  beforeAll(async () => {
    const base = { kind: 'BUSINESS' as const, severity: 'WARNING' as const, body: 'b', source: 's', audienceRoles: ['CS_LEAD', 'CS_EXEC'] };
    // A platform-wide rule (agentId null) opens alerts that each carry the agent they are about.
    const [rule] = await f.t.db.insert(alertRules).values({ id: uuidv7(), name: 'Escalation rate', kind: 'BUSINESS', condition: 'escalation_rate_above', audienceRoles: ['CS_LEAD'] }).returning();
    await f.t.db.insert(alerts).values([
      { ...base, id: ids.maya, ruleId: rule!.id, fingerprint: 'f-maya', title: 'Escalation rate · Maya', context: { agentId: f.agent.maya } },
      { ...base, id: ids.arjun, ruleId: rule!.id, fingerprint: 'f-arjun', title: 'Escalation rate · Arjun', context: { agentId: f.agent.arjun } },
      { ...base, id: ids.none, fingerprint: 'f-none', title: 'Queue age', context: {} },
    ]);
  });

  const titles = async (who: keyof OwnershipFixture['p']) => (await new AlertService(f.t.db, queue).list(actor(f.p[who]))).items.map((a) => a.title).sort();

  it('shows leads alerts of their agents and alerts about no agent; other agents’ alerts are not found', async () => {
    expect(await titles('leadA')).toEqual(['Escalation rate · Maya', 'Queue age']);
    expect(await titles('leadB')).toEqual(['Escalation rate · Arjun', 'Queue age']);
    const svc = new AlertService(f.t.db, queue);
    await expect(svc.get(actor(f.p.leadB), ids.maya)).rejects.toMatchObject(notFound);
    await expect(svc.acknowledge(actor(f.p.leadB), ids.maya)).rejects.toMatchObject(notFound);
    await expect(svc.list(actor(f.p.leadB), { agentId: f.agent.maya })).rejects.toMatchObject(notFound);
    expect((await svc.counts(actor(f.p.leadB))).unresolved).toBe(2);
    // Meera (Loans exec) reads Maya because Maya routes to her queue.
    expect(await titles('execB')).toEqual(['Escalation rate · Arjun', 'Escalation rate · Maya', 'Queue age']);
  });

  it('keeps the platform-wide rule visible to every lead, agent rules only to their agents’ leads', async () => {
    const rules = new AlertRuleService(f.t.db, queue);
    const mayaRule = await rules.create(actor(f.p.leadA), AlertRuleInput.parse({ name: 'Maya CSAT', kind: 'BUSINESS', condition: 'csat_below', agentId: f.agent.maya, audienceRoles: ['CS_LEAD'] }));
    const listed = async (who: 'leadA' | 'leadB') => (await rules.list(actor(f.p[who]), { kind: 'BUSINESS' })).map((r) => r.name).sort();
    expect(await listed('leadA')).toEqual(['Escalation rate', 'Maya CSAT']);
    expect(await listed('leadB')).toEqual(['Escalation rate']);
    await expect(rules.get(actor(f.p.leadB), mayaRule.id)).rejects.toMatchObject(notFound);
    await expect(rules.update(actor(f.p.leadB), mayaRule.id, { enabled: false })).rejects.toMatchObject(notFound);
    await expect(rules.create(actor(f.p.leadB), AlertRuleInput.parse({ name: 'x', kind: 'BUSINESS', condition: 'csat_below', agentId: f.agent.maya, audienceRoles: ['CS_LEAD'] }))).rejects.toMatchObject({ code: 'unknown_agent' });
  });
});
