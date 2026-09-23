import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from '@ocso/db/testing';
import {
  alertRules,
  alerts,
  conversationInsights,
  conversations,
  csatResponses,
  customers,
  handoffs,
  mcpConnections,
  toolCalls,
  uuidv7,
  virtualAgents,
} from '@ocso/db';
import { MemoryQueue } from '@ocso/queue';
import { createDefaultDeliveryRegistry } from '@ocso/alerts';
import { AlertEngine, type AlertRuleRow } from '../src/index.js';

/** Destination-kind event routing comes from the delivery registry (adapters declare their events). */
const routing = createDefaultDeliveryRegistry({ fetch: async () => new Response('') });

let t: TestDatabase;
let engine: AlertEngine;
const NOW = new Date();
const ago = (seconds: number) => new Date(NOW.getTime() - seconds * 1000);

beforeAll(async () => {
  t = await createTestDatabase();
  engine = new AlertEngine({ db: t.db, queue: new MemoryQueue(), destinations: routing });
});
afterAll(async () => {
  await t?.drop();
});

async function rule(condition: string, params: Record<string, unknown> = {}, extra: Partial<AlertRuleRow> = {}): Promise<AlertRuleRow> {
  const [row] = await t.db
    .insert(alertRules)
    .values({ id: uuidv7(), name: condition, kind: 'BUSINESS', condition, params, audienceRoles: ['HEAD'], windowSeconds: 3600, ...extra })
    .returning();
  return row!;
}

async function openAlerts(r: AlertRuleRow) {
  const summary = await engine.evaluate(NOW, { ruleIds: [r.id] });
  expect(summary.failed).toEqual([]);
  const rows = await t.db.select().from(alerts).where(eq(alerts.ruleId, r.id));
  return rows.filter((a) => a.status !== 'RESOLVED').sort((a, b) => a.title.localeCompare(b.title));
}

async function agent(name: string): Promise<string> {
  const id = uuidv7();
  await t.db.insert(virtualAgents).values({ id, name, slug: `${name.toLowerCase()}-${id.slice(-6)}`, conversationType: 'SALES' });
  return id;
}

async function conversation(agentId: string, fields: Partial<typeof conversations.$inferInsert> = {}): Promise<string> {
  const customerId = uuidv7();
  const id = uuidv7();
  await t.db.insert(customers).values({ id: customerId, displayName: 'Customer' });
  await t.db.insert(conversations).values({ id, customerId, agentId, type: 'SUPPORT', openedAt: ago(600), ...fields });
  return id;
}

async function handoff(conversationId: string, reasonCode = 'REFUND_LIMIT') {
  await t.db.insert(handoffs).values({
    id: uuidv7(),
    conversationId,
    trigger: 'AGENT_DECISION',
    reasonCode,
    reasonText: 'needs a human',
    requestedByType: 'AGENT',
    mode: 'OPEN_PICKUP',
    priority: 'P2',
    requestedAt: ago(300),
  });
}

describe('business evaluators', () => {
  it('escalation_rate_above: cohort of conversations opened in the window with a handoff', async () => {
    const maya = await agent('Maya');
    const arjun = await agent('Arjun');
    const mayaConvs = await Promise.all([1, 2, 3, 4].map(() => conversation(maya)));
    await Promise.all([1, 2, 3, 4].map(() => conversation(arjun)));
    await conversation(maya, { openedAt: ago(7200) }); // outside the window
    await handoff(mayaConvs[0]!, 'REFUND_LIMIT');
    await handoff(mayaConvs[1]!, 'CARD_DISPUTE');
    const open = await openAlerts(await rule('escalation_rate_above', { thresholdPercent: 25, minConversations: 4 }));
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ title: 'Escalation rate above 25.0% · Maya', value: '50.0%', source: 'Agent · Maya' });
    expect(open[0]!.context).toMatchObject({ agentId: maya, conversations: 4, escalated: 2, reasons: { REFUND_LIMIT: 1, CARD_DISPUTE: 1 } });
    expect((open[0]!.context['sampleConversationIds'] as string[]).sort()).toEqual([mayaConvs[0], mayaConvs[1]].sort());
    // Minimum volume guard.
    expect(await openAlerts(await rule('escalation_rate_above', { thresholdPercent: 25, minConversations: 50 }))).toHaveLength(0);
  });

  it('sla_breaches_above: open breaches awaiting a human plus late first responses in the window', async () => {
    const riya = await agent('Riya');
    const breached = await conversation(riya, { controlState: 'WAITING_FOR_HUMAN', slaDueAt: ago(120), waitingSince: ago(900) });
    await conversation(riya, { controlState: 'HUMAN_ACTIVE', slaDueAt: ago(900), firstHumanResponseAt: ago(600) });
    await conversation(riya, { controlState: 'HUMAN_ACTIVE', slaDueAt: ago(600), firstHumanResponseAt: ago(900) }); // met
    await conversation(riya, { controlState: 'WAITING_FOR_HUMAN', slaDueAt: new Date(NOW.getTime() + 60_000) }); // not yet due
    const open = await openAlerts(await rule('sla_breaches_above', { threshold: 0 }, { agentId: riya }));
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ title: 'SLA breaches · Riya', value: '2' });
    expect(open[0]!.context).toMatchObject({ openBreaches: 1, missedInWindow: 1, agentId: riya });
    expect(open[0]!.context['sampleConversationIds']).toContain(breached);
    expect(await openAlerts(await rule('sla_breaches_above', { threshold: 5 }, { agentId: riya }))).toHaveLength(0);
  });

  it('resolution_sla_breaches_above: open conversations past their resolution target plus late resolutions', async () => {
    const arjun = await agent('Arjun');
    const late = await conversation(arjun, { controlState: 'HUMAN_ACTIVE', resolutionDueAt: ago(300) });
    await conversation(arjun, { controlState: 'RESOLVED', resolutionDueAt: ago(900), resolvedAt: ago(600) }); // resolved late in the window
    await conversation(arjun, { controlState: 'RESOLVED', resolutionDueAt: ago(600), resolvedAt: ago(900) }); // met
    await conversation(arjun, { controlState: 'AI_ACTIVE', resolutionDueAt: new Date(NOW.getTime() + 60_000) }); // not yet due
    const open = await openAlerts(await rule('resolution_sla_breaches_above', { threshold: 0 }, { agentId: arjun }));
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ title: 'Resolution SLA breaches · Arjun', value: '2' });
    expect(open[0]!.context).toMatchObject({ openBreaches: 1, resolvedLateInWindow: 1 });
    expect(open[0]!.context['sampleConversationIds']).toContain(late);
  });

  it('repeated_failure_topic: normalized failureTopic counts per agent', async () => {
    const maya = await agent('Maya2');
    const topics = ['Card block', 'card  block', ' CARD BLOCK ', 'Refund status'];
    for (const failureTopic of topics) {
      await t.db.insert(conversationInsights).values({ conversationId: uuidv7(), agentId: maya, failureTopic, methodVersion: 'insights-v1', generatedAt: ago(120) });
    }
    const open = await openAlerts(await rule('repeated_failure_topic', { minOccurrences: 3 }, { agentId: maya }));
    expect(open).toHaveLength(1);
    expect(open[0]!.title).toMatch(/^Repeated failure topic · .+ · Maya2$/);
    expect(open[0]).toMatchObject({ value: '3 conversations' });
    expect(open[0]!.context).toMatchObject({ occurrences: 3 });
  });

  it('tool_failure_rate_above: FAILED / finished calls per tool; denied calls are not failures', async () => {
    const connectionId = uuidv7();
    await t.db.insert(mcpConnections).values({ id: connectionId, name: 'meridian-crm', url: 'https://crm.test/mcp', status: 'ACTIVE' });
    const call = (toolName: string, status: 'SUCCEEDED' | 'FAILED' | 'DENIED', errorCategory?: string) => ({
      id: uuidv7(),
      toolName,
      connectionId,
      actorType: 'AGENT' as const,
      actorId: 'agent',
      argsSanitized: {},
      argsHash: 'h',
      status,
      errorCategory: errorCategory ?? null,
      requestedAt: ago(200),
    });
    await t.db.insert(toolCalls).values([
      ...Array.from({ length: 8 }, () => call('disputes.raise_case', 'SUCCEEDED')),
      ...Array.from({ length: 2 }, () => call('disputes.raise_case', 'FAILED', 'conflict')),
      ...Array.from({ length: 10 }, () => call('kb.search', 'SUCCEEDED')),
      ...Array.from({ length: 5 }, () => call('kb.search', 'DENIED')),
    ]);
    const open = await openAlerts(await rule('tool_failure_rate_above', { thresholdPercent: 5, minCalls: 10 }));
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ title: 'Tool failure rate above 5.0% · disputes.raise_case', value: '20.0%', source: 'Tool · disputes.raise_case' });
    expect(open[0]!.body).toContain('(meridian-crm)');
    expect(open[0]!.context).toMatchObject({ calls: 10, failures: 2, errorCategories: { conflict: 2 } });
  });

  it('csat_below: mean score per agent with a minimum response count', async () => {
    const low = await agent('LowCsat');
    const high = await agent('HighCsat');
    const csat = (agentId: string, score: number, handledByHuman = false) => ({ id: uuidv7(), conversationId: uuidv7(), agentId, score, handledByHuman, receivedAt: ago(300) });
    await t.db.insert(csatResponses).values([
      ...[3, 3, 3, 2, 4].map((s) => csat(low, s)),
      csat(low, 5, true),
      ...[5, 5, 4, 5, 4, 5].map((s) => csat(high, s)),
    ]);
    const open = await openAlerts(await rule('csat_below', { threshold: 4, minResponses: 5 }));
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ title: 'CSAT below 4.0 · LowCsat', value: '3.33' });
    expect(open[0]!.context).toMatchObject({ responses: 6, averageAi: 3, averageHuman: 5 });
  });

  it('conversion_drop: current conversion vs trailing baseline, both with minimum volume', async () => {
    const arjun = await agent('Closer');
    const insight = (salesOutcome: string, secondsAgo: number) => ({ conversationId: uuidv7(), agentId: arjun, salesOutcome, methodVersion: 'insights-v1', generatedAt: ago(secondsAgo) });
    await t.db.insert(conversationInsights).values([
      // Baseline (previous two 1h windows): 6 of 10 converted.
      ...Array.from({ length: 6 }, () => insight('converted', 5400)),
      ...Array.from({ length: 4 }, () => insight('LOST', 5400)),
      // Current window: 2 of 10 converted.
      ...Array.from({ length: 2 }, () => insight('Won', 600)),
      ...Array.from({ length: 8 }, () => insight('NO_SALE', 600)),
    ]);
    const open = await openAlerts(await rule('conversion_drop', { dropPercent: 30, minOutcomes: 10, baselineWindows: 2 }, { agentId: arjun }));
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ title: 'Conversion drop · Closer', value: '20.0%' });
    expect(open[0]!.context).toMatchObject({ currentRate: 0.2, baselineRate: 0.6, currentOutcomes: 10, baselineOutcomes: 10 });
    expect(await openAlerts(await rule('conversion_drop', { dropPercent: 90, minOutcomes: 10, baselineWindows: 2 }, { agentId: arjun }))).toHaveLength(0);
  });
});
