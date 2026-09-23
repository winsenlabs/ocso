import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from '@ocso/db/testing';
import { alertRules, alerts, deploymentSettings, modelPricing, usageEvents, uuidv7, virtualAgents } from '@ocso/db';
import { MemoryQueue } from '@ocso/queue';
import { createDefaultDeliveryRegistry } from '@ocso/alerts';
import { AlertEngine, type AlertRuleRow } from '../src/index.js';

/** Destination-kind event routing comes from the delivery registry (adapters declare their events). */
const routing = createDefaultDeliveryRegistry({ fetch: async () => new Response('') });

/**
 * spend_budget_above (TECHNICAL): month-to-date spend in the deployment
 * timezone against a monthly USD budget; each threshold fires once per
 * month, alerts resolve at month rollover, the body projects month-end spend.
 */

let t: TestDatabase;
let engine: AlertEngine;
// Deployment timezone Asia/Kolkata (UTC+5:30): September starts 2026-08-31T18:30Z.
const MONTH_START = new Date('2026-08-31T18:30:00Z');
const MONTH_END = new Date('2026-09-30T18:30:00Z');
/** Day 10 of the 30-day month, 00:00 IST. */
const NOW = new Date('2026-09-09T18:30:00Z');
const USD = 1_000_000;

beforeAll(async () => {
  t = await createTestDatabase();
  engine = new AlertEngine({ db: t.db, queue: new MemoryQueue(), destinations: routing });
  await t.db.update(deploymentSettings).set({ timezone: 'Asia/Kolkata' }).where(eq(deploymentSettings.id, 1));
});
afterAll(async () => {
  await t?.drop();
});

async function rule(params: Record<string, unknown>, extra: Partial<AlertRuleRow> = {}): Promise<AlertRuleRow> {
  const [row] = await t.db
    .insert(alertRules)
    .values({ id: uuidv7(), name: 'Monthly model budget', kind: 'TECHNICAL', condition: 'spend_budget_above', params, audienceRoles: ['TECH'], windowSeconds: 3600, ...extra })
    .returning();
  return row!;
}

async function run(r: AlertRuleRow, at: Date = NOW) {
  const summary = await engine.evaluate(at, { ruleIds: [r.id] });
  expect(summary.failed).toEqual([]);
  const rows = await t.db.select().from(alerts).where(eq(alerts.ruleId, r.id));
  return { summary, open: rows.filter((a) => a.status !== 'RESOLVED').sort((a, b) => a.title.localeCompare(b.title)), all: rows };
}

const spend = (usd: number, o: Partial<typeof usageEvents.$inferInsert> = {}) => ({
  id: uuidv7(),
  purpose: 'TURN',
  status: 'OK' as const,
  occurredAt: new Date('2026-09-05T10:00:00Z'),
  providerKind: 'OPENAI' as const,
  model: 'gpt-5.4-mini',
  inputTokens: 1000,
  uncachedInputTokens: 1000,
  outputTokens: 100,
  costMicros: Math.round(usd * USD),
  currency: 'USD',
  ...o,
});

describe('spend_budget_above', () => {
  it('fires per threshold with the month-to-date spend (deployment timezone) and a month-end projection', async () => {
    await t.db.insert(usageEvents).values([
      spend(50),
      spend(30),
      // 2026-09-01 01:30 IST: September in the deployment timezone (still August in UTC).
      spend(5, { occurredAt: new Date('2026-08-31T20:00:00Z') }),
      // 2026-08-31 23:30 IST: August — not counted.
      spend(400, { occurredAt: new Date('2026-08-31T18:00:00Z') }),
      // Failed requests carry no cost.
      spend(0, { status: 'ERROR', costMicros: null, currency: null, inputTokens: 0, uncachedInputTokens: 0, outputTokens: 0 }),
    ]);
    const r = await rule({ monthlyBudgetUsd: 100 });
    const first = await run(r);
    expect(first.open).toHaveLength(1);
    const elapsed = NOW.getTime() - MONTH_START.getTime();
    const projected = Math.round((85 * USD * (MONTH_END.getTime() - MONTH_START.getTime())) / elapsed);
    expect(first.open[0]).toMatchObject({ title: 'Monthly model spend reached 80% of budget · all agents', value: '85.0%', source: 'Model usage · spend', severity: 'WARNING' });
    expect(first.open[0]!.body).toBe(
      `Model spend for all agents in 2026-09 (Asia/Kolkata) is 85.00 USD of the 100.00 USD monthly budget (85.0%; threshold 80%). Projected month-end spend at the current run rate: ${(projected / USD).toFixed(2)} USD.`,
    );
    expect(first.open[0]!.context).toMatchObject({ month: '2026-09', timezone: 'Asia/Kolkata', monthStart: MONTH_START.toISOString(), monthEnd: MONTH_END.toISOString(), spendMicros: 85 * USD, projectedMonthEndMicros: projected, budgetMicros: 100 * USD, thresholdPercent: 80, condition: 'spend_budget_above' });

    await t.db.insert(usageEvents).values(spend(20));
    const second = await run(r);
    expect(second.open.map((a) => a.title)).toEqual([
      'Monthly model spend reached 100% of budget · all agents',
      'Monthly model spend reached 80% of budget · all agents',
    ]);
    expect(second.open.find((a) => a.title.includes('80%'))).toMatchObject({ occurrences: 2, value: '105.0%' });
    expect(second.summary).toMatchObject({ opened: 1, updated: 1 });

    // Once per threshold per month: a person resolves the 80% alert; it does not reopen this month.
    const eighty = second.open.find((a) => a.title.includes('80%'))!;
    await t.db.update(alerts).set({ status: 'RESOLVED', resolvedAt: NOW }).where(eq(alerts.id, eighty.id));
    const third = await run(r, new Date(NOW.getTime() + 10 * 86_400_000));
    expect(third.open.map((a) => a.title)).toEqual(['Monthly model spend reached 100% of budget · all agents']);
    expect(third.all.filter((a) => a.fingerprint === eighty.fingerprint)).toHaveLength(1);

    // Month rollover (October, IST): nothing spent yet → the open alert resolves.
    const october = await run(r, new Date('2026-10-01T04:00:00Z'));
    expect(october.open).toEqual([]);
    expect(october.all.every((a) => a.status === 'RESOLVED')).toBe(true);
    expect(october.summary.resolved).toBe(1);
  });

  it('unpriced usage: priced now by model_pricing when a row matches, otherwise reported and never valued at zero', async () => {
    const agentId = uuidv7();
    await t.db.insert(virtualAgents).values({ id: agentId, name: 'Maya', slug: `maya-${agentId.slice(-6)}`, conversationType: 'SUPPORT' });
    await t.db.insert(modelPricing).values({
      id: uuidv7(),
      providerKind: 'ANTHROPIC',
      modelPattern: 'claude-haiku-4-5',
      origin: 'catalog',
      inputPerMTokMicros: 1 * USD,
      outputPerMTokMicros: 5 * USD,
      effectiveFrom: new Date('2026-09-01T00:00:00Z'),
    });
    await t.db.insert(usageEvents).values([
      spend(9, { agentId }),
      // Recorded before the price row existed: 1M input + 0.2M output → 1 + 1 = 2 USD at today's price.
      spend(0, { agentId, providerKind: 'ANTHROPIC', model: 'claude-haiku-4-5', costMicros: null, currency: null, inputTokens: 1_000_000, uncachedInputTokens: 1_000_000, outputTokens: 200_000 }),
      spend(0, { agentId, model: 'gpt-private-ft', costMicros: null, currency: null }),
      spend(0, { agentId, model: 'gpt-private-ft', costMicros: null, currency: null }),
      // Other agents do not count for an agent-scoped rule.
      spend(500),
    ]);
    const r = await rule({ monthlyBudgetUsd: 10, thresholdsPercent: [100] }, { agentId });
    const { open } = await run(r);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ title: 'Monthly model spend reached 100% of budget · Maya', value: '110.0%' });
    expect(open[0]!.body).toContain('is 11.00 USD of the 10.00 USD monthly budget');
    expect(open[0]!.body).toContain('2 request(s) have no price and are not counted (openai gpt-private-ft)');
    expect(open[0]!.context).toMatchObject({ agentId, repricedMicros: 2 * USD, unpricedRequests: 2, unpricedModels: ['openai gpt-private-ft'] });
  });

  it('a changed budget is a new alert; params are validated', async () => {
    const r = await rule({ monthlyBudgetUsd: 1000 });
    expect((await run(r)).open).toEqual([]);
    await t.db.update(alertRules).set({ params: { monthlyBudgetUsd: 50, thresholdsPercent: [50] } }).where(eq(alertRules.id, r.id));
    const [updated] = await t.db.select().from(alertRules).where(eq(alertRules.id, r.id));
    expect((await run(updated!)).open).toHaveLength(1);
    const bad = await rule({ monthlyBudgetUsd: -5 });
    const summary = await engine.evaluate(NOW, { ruleIds: [bad.id] });
    expect(summary.failed).toEqual([expect.objectContaining({ condition: 'spend_budget_above' })]);
  });
});
