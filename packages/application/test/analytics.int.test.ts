import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from '@ocso/db/testing';
import {
  agentChannels,
  alerts,
  auditEvents,
  channels,
  conversationInsights,
  conversationReviews,
  conversations,
  csatResponses,
  customerIdentities,
  customers,
  handoffs,
  interactionParts,
  interactions,
  promptCorrections,
  promptVersions,
  queueTeams,
  queues,
  teamMembers,
  teams,
  toolCalls,
  usageEvents,
  users,
  uuidv7,
  virtualAgents,
} from '@ocso/db';
import type { Principal } from '@ocso/auth';
import { AgentAnalyticsService, HomeService, QueueAnalyticsService, agentComparison, agentSummaries } from '../src/analytics/index.js';
import { ownAgents } from './support/ownership.js';

const now = new Date();
const SEC = 1000;
const MIN = 60 * SEC;
const DAY = 86_400_000;
const HOURS = (n: number) => n * 3_600_000;
const ago = (ms: number) => new Date(now.getTime() - ms);
const plus = (d: Date, ms: number) => new Date(d.getTime() + ms);
const dayStartUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

let t: TestDatabase;
const id: Record<string, string> = {};
const P = (userId: string, role: Principal['role'], teamIds: string[] = []): Principal => ({ userId, role, displayName: role, teamIds, via: 'UI' });
let lead: Principal;
let exec: Principal;
let admin: Principal;

interface ConvSpec {
  key: string;
  agent: string;
  channel: string;
  opened: Date;
  state: string;
  customer: string;
  queue?: string;
  assigned?: string;
  resolvedAfter?: number;
  reopen?: number;
  slaDueAt?: Date;
  firstHumanAfter?: number;
  waitingSince?: Date;
  priority?: 'P1' | 'P3';
  preview?: string;
}

async function conv(s: ConvSpec) {
  const customerId = uuidv7();
  await t.db.insert(customers).values({ id: customerId, displayName: s.customer });
  await t.db.insert(customerIdentities).values({ id: uuidv7(), customerId, kind: 'whatsapp_phone', value: `+9198${Math.floor(Math.random() * 1e8).toString().padStart(8, '0')}` });
  const convId = uuidv7();
  id[s.key] = convId;
  await t.db.insert(conversations).values({
    id: convId,
    customerId,
    agentId: id[s.agent]!,
    channelId: id[s.channel]!,
    type: s.agent === 'maya' ? 'SUPPORT' : 'SALES',
    controlState: s.state,
    queueId: s.queue ? id[s.queue]! : null,
    assignedUserId: s.assigned ?? null,
    openedAt: s.opened,
    lastInteractionAt: s.opened,
    resolvedAt: s.resolvedAfter !== undefined ? plus(s.opened, s.resolvedAfter * SEC) : null,
    reopenCount: s.reopen ?? 0,
    slaDueAt: s.slaDueAt ?? null,
    firstHumanResponseAt: s.firstHumanAfter !== undefined ? plus(s.opened, s.firstHumanAfter * SEC) : null,
    waitingSince: s.waitingSince ?? null,
    priority: s.priority ?? 'P3',
    lastPreview: s.preview ?? null,
  });
  return convId;
}

async function msg(key: string, seq: number, actorType: 'CUSTOMER' | 'AGENT' | 'HUMAN', afterSec: number, text: string, actorId: string | null = null) {
  const [c] = await t.db.select({ opened: conversations.openedAt }).from(conversations).where(eqId(id[key]!));
  const iid = uuidv7();
  await t.db.insert(interactions).values({ id: iid, conversationId: id[key]!, seq, actorType, actorId, direction: actorType === 'CUSTOMER' ? 'INBOUND' : 'OUTBOUND', visibility: 'CUSTOMER', correlationId: 'seed', preview: text, createdAt: plus(c!.opened, afterSec * SEC) });
  await t.db.insert(interactionParts).values({ id: uuidv7(), interactionId: iid, idx: 0, type: 'TEXT', content: { type: 'TEXT', text } });
}

const eqId = (value: string) => eq(conversations.id, value);

async function handoff(key: string, o: { trigger: string; code: string; text: string; requestedAfter: number; acceptedAfter?: number; queue?: string; status: 'WAITING' | 'ACTIVE' | 'RESOLVED' }) {
  const [c] = await t.db.select({ opened: conversations.openedAt }).from(conversations).where(eqId(id[key]!));
  await t.db.insert(handoffs).values({
    id: uuidv7(), conversationId: id[key]!, trigger: o.trigger, reasonCode: o.code, reasonText: o.text, requestedByType: 'AGENT', mode: 'OPEN_PICKUP', priority: 'P3', status: o.status,
    queueId: o.queue ? id[o.queue]! : null, requestedAt: plus(c!.opened, o.requestedAfter * SEC), acceptedAt: o.acceptedAfter !== undefined ? plus(c!.opened, o.acceptedAfter * SEC) : null,
  });
}

async function seed() {
  const db = t.db;
  id.lead = uuidv7();
  id.exec = uuidv7();
  id.admin = uuidv7();
  await db.insert(users).values([
    { id: id.lead, email: 'lead@x.test', name: 'Anjali Rao', role: 'CS_LEAD' },
    { id: id.exec, email: 'exec@x.test', name: 'Nikhil Menon', role: 'CS_EXEC', availability: 'AVAILABLE', languages: ['en', 'mr'] },
    { id: id.admin, email: 'admin@x.test', name: 'T. Shetty', role: 'PLATFORM_TECH_ADMIN' },
  ]);
  id.team = uuidv7();
  await db.insert(teams).values({ id: id.team, name: 'Cards' });
  await db.insert(teamMembers).values([
    { teamId: id.team, userId: id.exec },
    { teamId: id.team, userId: id.lead },
  ]);
  id.q1 = uuidv7();
  id.q2 = uuidv7();
  await db.insert(queues).values([
    { id: id.q1, name: 'Cards & EMI' },
    { id: id.q2, name: 'Hardship desk' },
  ]);
  await db.insert(queueTeams).values({ queueId: id.q1, teamId: id.team });
  // The lead's team owns both agents (ADR-026); scoping itself is covered in agent-ownership.int.test.ts.
  lead = P(id.lead, 'CS_LEAD', [id.team]);
  exec = P(id.exec, 'CS_EXEC', [id.team]);
  admin = P(id.admin, 'PLATFORM_TECH_ADMIN');

  id.maya = uuidv7();
  id.arjun = uuidv7();
  await db.insert(virtualAgents).values([
    { id: id.maya, name: 'Maya', slug: 'maya', conversationType: 'SUPPORT', status: 'LIVE' },
    { id: id.arjun, name: 'Arjun', slug: 'arjun', conversationType: 'SALES', status: 'LIVE' },
  ]);
  await ownAgents(db, id.team, id.maya, id.arjun);
  const version = (n: number, createdAt: Date) => ({
    id: uuidv7(), agentId: id.maya!, version: n, components: { behavior: `v${n}` }, componentHashes: {}, promptHash: `pc_${n}`, runtimeContractVersion: '1', changedComponents: ['behavior'], reason: `reason v${n}`, createdAt,
  });
  const [v1, v2] = [version(1, ago(20 * DAY)), version(2, ago(3 * DAY))];
  await db.insert(promptVersions).values([v1, v2]);
  await db.update(virtualAgents).set({ activePromptVersionId: v2.id }).where(eq(virtualAgents.id, id.maya));
  const activate = (v: typeof v1, at: Date) => ({ id: uuidv7(), occurredAt: at, actorType: 'USER' as const, actorId: id.lead!, actorName: 'Anjali Rao', via: 'UI' as const, action: 'prompt.activate', targetType: 'agent', targetId: id.maya!, summary: 'Activated', after: { activePromptVersionId: v.id } });
  await db.insert(auditEvents).values([activate(v1, ago(20 * DAY)), activate(v2, ago(3 * DAY))]);

  id.wa = uuidv7();
  id.web = uuidv7();
  await db.insert(channels).values([
    { id: id.wa, kind: 'WHATSAPP', name: 'WhatsApp', status: 'ACTIVE', publicKey: 'pk-a-wa' },
    { id: id.web, kind: 'WEBCHAT', name: 'Web chat', status: 'ACTIVE', publicKey: 'pk-a-web' },
  ]);
  await db.insert(agentChannels).values([
    { agentId: id.maya, channelId: id.wa },
    { agentId: id.maya, channelId: id.web },
    { agentId: id.arjun, channelId: id.web },
  ]);

  // Maya cohort (last 7 days): c1..c6. Previous window: c7, c8.
  await conv({ key: 'c1', agent: 'maya', channel: 'wa', opened: ago(2 * DAY), state: 'RESOLVED', customer: 'Arvind Nair', resolvedAfter: 60 });
  await msg('c1', 1, 'CUSTOMER', 0, 'my EMI was debited twice');
  await msg('c1', 2, 'AGENT', 4, 'I can see two debits');
  await conv({ key: 'c2', agent: 'maya', channel: 'wa', opened: ago(20 * MIN), state: 'RESOLVED', customer: 'Priya Deshmukh', queue: 'q1', resolvedAfter: 900, firstHumanAfter: 100, slaDueAt: plus(ago(20 * MIN), 330 * SEC) });
  await msg('c2', 1, 'CUSTOMER', 0, 'refund 12480 please');
  await msg('c2', 2, 'AGENT', 6, 'That is above my authority');
  await msg('c2', 3, 'HUMAN', 100, 'Hi, Nikhil here', id.exec);
  await handoff('c2', { trigger: 'AGENT_DECISION', code: 'refund_above_authority', text: 'refund above authority', requestedAfter: 30, acceptedAfter: 90, queue: 'q1', status: 'RESOLVED' });
  await conv({ key: 'c3', agent: 'maya', channel: 'web', opened: ago(DAY), state: 'WAITING_FOR_HUMAN', customer: 'Farida Sheikh', queue: 'q1', slaDueAt: ago(10 * MIN), waitingSince: ago(30 * MIN), priority: 'P1' });
  await msg('c3', 1, 'CUSTOMER', 0, 'I want to talk to a person about my EMI');
  await msg('c3', 2, 'AGENT', 10, 'Connecting you');
  await handoff('c3', { trigger: 'CUSTOMER_REQUEST', code: 'customer_asked_for_human', text: 'customer asked for a human', requestedAfter: 12, queue: 'q1', status: 'WAITING' });
  await conv({ key: 'c4', agent: 'maya', channel: 'web', opened: ago(3 * DAY), state: 'HUMAN_ACTIVE', customer: 'Suresh Pillai', assigned: id.exec, slaDueAt: plus(ago(3 * DAY), 60 * SEC), firstHumanAfter: 120, preview: 'card replacement courier' });
  await msg('c4', 1, 'CUSTOMER', 0, 'where is my card');
  await msg('c4', 2, 'AGENT', 2, 'Checking');
  await msg('c4', 3, 'HUMAN', 120, 'I have taken over', id.exec);
  await handoff('c4', { trigger: 'HUMAN_REQUEST', code: 'human_take_over', text: 'Nikhil took over', requestedAfter: 100, acceptedAfter: 100, status: 'ACTIVE' });
  await conv({ key: 'c5', agent: 'maya', channel: 'wa', opened: ago(4 * DAY), state: 'AI_ACTIVE', customer: 'Kiran Rao' });
  await msg('c5', 1, 'CUSTOMER', 0, 'hello');
  await conv({ key: 'c6', agent: 'maya', channel: 'wa', opened: ago(5 * DAY), state: 'RESOLVED', customer: 'Deepa Raman', resolvedAfter: 300, reopen: 1 });
  await msg('c6', 1, 'CUSTOMER', 0, 'foreclosure charges?');
  await msg('c6', 2, 'AGENT', 8, 'Let me check');
  await conv({ key: 'c7', agent: 'maya', channel: 'wa', opened: ago(10 * DAY), state: 'RESOLVED', customer: 'Old One', resolvedAfter: 60 });
  await conv({ key: 'c8', agent: 'maya', channel: 'wa', opened: ago(11 * DAY), state: 'RESOLVED', customer: 'Old Two', resolvedAfter: 60 });
  await handoff('c8', { trigger: 'AGENT_DECISION', code: 'refund_above_authority', text: 'refund above authority', requestedAfter: 10, acceptedAfter: 20, status: 'RESOLVED' });
  // Arjun cohort: c9, c10 resolved with sales outcomes; c11 waiting in an unstaffed queue.
  await conv({ key: 'c9', agent: 'arjun', channel: 'web', opened: ago(2 * DAY), state: 'RESOLVED', customer: 'Mohit Bansal', resolvedAfter: 60 });
  await conv({ key: 'c10', agent: 'arjun', channel: 'web', opened: ago(2 * DAY), state: 'RESOLVED', customer: 'Sneha Kulkarni', resolvedAfter: 60 });
  await conv({ key: 'c11', agent: 'arjun', channel: 'web', opened: ago(DAY), state: 'WAITING_FOR_HUMAN', customer: 'Nandini Shah', queue: 'q2', waitingSince: ago(HOURS(2)) });
  await handoff('c11', { trigger: 'AGENT_DECISION', code: 'pricing_exception', text: 'pricing exception', requestedAfter: 5, queue: 'q2', status: 'WAITING' });

  const call = (key: string, actorType: 'AGENT' | 'HUMAN', status: 'SUCCEEDED' | 'FAILED' | 'DENIED') => ({
    id: uuidv7(), conversationId: id[key]!, toolName: 'cards.list', actorType, actorId: 'x', argsSanitized: {}, argsHash: 'h', status, requestedAt: ago(DAY),
  });
  await db.insert(toolCalls).values([call('c1', 'AGENT', 'SUCCEEDED'), call('c1', 'AGENT', 'SUCCEEDED'), call('c1', 'AGENT', 'SUCCEEDED'), call('c1', 'AGENT', 'FAILED'), call('c2', 'AGENT', 'DENIED'), call('c2', 'HUMAN', 'FAILED')]);
  await db.insert(csatResponses).values([
    { id: uuidv7(), conversationId: id.c1!, agentId: id.maya, score: 5, handledByHuman: false, receivedAt: ago(2 * DAY) },
    { id: uuidv7(), conversationId: id.c2!, agentId: id.maya, score: 3, handledByHuman: true, receivedAt: ago(4 * MIN) },
    { id: uuidv7(), conversationId: id.c7!, agentId: id.maya, score: 1, handledByHuman: false, receivedAt: ago(10 * DAY) },
  ]);
  await db.update(conversations).set({ csatScore: 3 }).where(eqId(id.c2!));
  const usage = (costMicros: number, at: Date) => ({ id: uuidv7(), occurredAt: at, purpose: 'TURN', status: 'OK' as const, agentId: id.maya!, inputTokens: 1000, cachedInputTokens: 500, costMicros, currency: 'USD' });
  await db.insert(usageEvents).values([usage(100, ago(DAY)), usage(200, ago(DAY)), usage(300, ago(DAY)), usage(999, ago(10 * DAY))]);
  const insight = (key: string, o: Partial<typeof conversationInsights.$inferInsert>) => ({ conversationId: id[key]!, agentId: key.startsWith('c9') || key === 'c10' ? id.arjun! : id.maya!, methodVersion: 'insights.v1+test', ...o });
  await db.insert(conversationInsights).values([
    insight('c1', { topic: 'Duplicate EMI debit', outcome: 'RESOLVED_BY_AI', sentiment: 'POSITIVE' }),
    insight('c2', { topic: 'Refund request', outcome: 'RESOLVED_BY_HUMAN', failureTopic: 'EMI foreclosure', knowledgeGap: 'Foreclosure charge table', sentiment: 'NEUTRAL' }),
    insight('c3', { topic: 'human request', outcome: 'ESCALATED', failureTopic: 'emi   foreclosure', knowledgeGap: 'Address proof list', sentiment: 'NEGATIVE' }),
    insight('c6', { topic: 'duplicate emi debit ', outcome: 'RESOLVED_BY_AI', failureTopic: 'EMI Foreclosure', knowledgeGap: 'foreclosure charge table', sentiment: 'NEGATIVE' }),
    insight('c7', { knowledgeGap: 'Foreclosure charge table', generatedAt: ago(10 * DAY) }),
    insight('c9', { salesOutcome: 'converted', outcome: 'RESOLVED_BY_AI' }),
    insight('c10', { salesOutcome: 'Not interested', outcome: 'RESOLVED_BY_AI' }),
  ]);
  const correction = (title: string, status: 'OPEN' | 'STAGED' | 'APPLIED', occurrences: number) => ({ id: uuidv7(), agentId: id.maya!, title, observed: 'o', desired: 'd', componentKey: 'behavior', status, occurrences });
  await db.insert(promptCorrections).values([correction('Offer reversal first', 'OPEN', 5), correction('Stop promising 24h', 'OPEN', 2), correction('Escalate hardship', 'STAGED', 1), correction('Old fix', 'APPLIED', 9)]);
  await db.insert(conversationReviews).values({ id: uuidv7(), conversationId: id.c2!, agentId: id.maya, reviewerId: id.lead, outcomeTag: 'good handoff', score: 4, rubric: { accuracy: 4, policy: 5, tone: 3, resolution: 4 }, createdAt: ago(HOURS(1)) });
  const audit = (action: string, key: string, at: Date) => ({ id: uuidv7(), occurredAt: at, actorType: 'USER' as const, actorId: id.exec!, actorName: 'Nikhil Menon', via: 'UI' as const, action, targetType: 'conversation', targetId: id[key]!, summary: action });
  await db.insert(auditEvents).values([audit('conversation.claim', 'c2', plus(ago(20 * MIN), 90 * SEC)), audit('conversation.resolve', 'c2', new Date(Math.max(ago(5 * MIN).getTime(), dayStartUtc.getTime() + SEC)))]);
  await db.insert(alerts).values([
    { id: uuidv7(), fingerprint: 'esc-maya', kind: 'BUSINESS', severity: 'WARNING', title: 'Escalation rate above 25% · Maya', body: 'b', audienceRoles: ['CS_LEAD', 'CS_EXEC'], source: 'Agent · Maya', context: { agentId: id.maya } },
    { id: uuidv7(), fingerprint: 'ttft', kind: 'TECHNICAL', severity: 'CRITICAL', title: 'TTFT above SLO', body: 'b', audienceRoles: ['PLATFORM_TECH_ADMIN'], source: 'AWS Bedrock' },
  ]);
}

beforeAll(async () => {
  t = await createTestDatabase();
  await seed();
});
afterAll(async () => {
  await t?.drop();
});

describe('agent analytics', () => {
  it('computes cohort tiles with their formulas', async () => {
    const a = await new AgentAnalyticsService(t.db, () => now).analytics(lead, id.maya!, 7);
    const tiles = a.tiles;
    expect(tiles.conversations).toMatchObject({ value: 6, previous: 2 });
    expect(tiles.containmentRate.value).toBeCloseTo(3 / 6); // c1, c5, c6 had no handoff
    expect(tiles.escalationRate.value).toBeCloseTo(2 / 6); // c2 agent decision, c3 customer request; c4 take-over excluded
    expect(tiles.escalationRate.previous).toBeCloseTo(1 / 2);
    expect(tiles.resolutionRate.value).toBeCloseTo(3 / 6);
    expect(tiles.firstResponseAiMedianSeconds.value).toBe(6); // 2, 4, 6, 8, 10
    expect(tiles.slaBreaches.value).toBe(2); // c3 waiting past due, c4 first human response after due
    expect(tiles.toolFailureRate.value).toBeCloseTo(1 / 4); // denied + human calls excluded
    expect(tiles.csat.value).toMatchObject({ average: 4, responses: 2, aiHandledAverage: 5, humanHandledAverage: 3 });
    expect(tiles.csat.previous).toMatchObject({ average: 1, responses: 1 });
    for (const tile of Object.values(tiles)) expect(tile.definition.length).toBeGreaterThan(10);
  });

  it('breaks down resolution, reopen, handling time, cost and channels', async () => {
    const a = await new AgentAnalyticsService(t.db, () => now).analytics(lead, id.maya!, 7);
    expect(a.timeToResolution.medianSeconds).toBe(300); // 60, 300, 900
    expect(a.reopenRate).toMatchObject({ reopened: 1, resolvedEver: 3 });
    expect(a.reopenRate.value).toBeCloseTo(1 / 3);
    expect(a.handlingTime.buckets).toEqual([
      { bucket: '<2m', ai: 1, human: 0, total: 1 },
      { bucket: '2-10m', ai: 1, human: 0, total: 1 },
      { bucket: '10-30m', ai: 0, human: 1, total: 1 },
      { bucket: '>30m', ai: 0, human: 0, total: 0 },
    ]);
    expect(a.handlingTime).toMatchObject({ aiMedianSeconds: 180, humanMedianSeconds: 900 });
    expect(a.costPerConversation).toMatchObject({ valueMicros: 100, costMicros: 600, currency: 'USD', conversations: 6, cachedInputShare: 0.5 });
    const wa = a.channels.items.find((c) => c.kind === 'WHATSAPP')!;
    expect(wa).toMatchObject({ conversations: 4, contained: 3, containmentRate: 0.75, csat: 4, csatResponses: 2 });
    expect(a.channels.items.find((c) => c.kind === 'WEBCHAT')).toMatchObject({ conversations: 2, contained: 0, csat: null, csatResponses: 0 });
  });

  it('reports escalation reasons, insight topics, knowledge gaps, corrections and reviews', async () => {
    const a = await new AgentAnalyticsService(t.db, () => now).analytics(lead, id.maya!, 7);
    expect(a.escalationReasons.total).toBe(2);
    expect(a.escalationReasons.reasons.map((r) => `${r.reasonCode}:${r.count}`).sort()).toEqual(['customer_asked_for_human:1', 'refund_above_authority:1']);
    expect(a.failureTopics.items).toEqual([{ key: 'emi foreclosure', label: expect.any(String), count: 3 }]);
    expect(a.topics.items[0]).toMatchObject({ key: 'duplicate emi debit', count: 2 });
    expect(a.knowledgeGaps.items).toEqual([
      expect.objectContaining({ key: 'foreclosure charge table', count: 2, isNew: false }),
      expect.objectContaining({ key: 'address proof list', count: 1, isNew: true }),
    ]);
    expect(a.knowledgeGaps.newCount).toBe(1);
    expect(a.outcomes).toMatchObject({ analyzed: 4, outcomes: { RESOLVED_BY_AI: 2, RESOLVED_BY_HUMAN: 1, ESCALATED: 1 }, sentiments: { POSITIVE: 1, NEUTRAL: 1, NEGATIVE: 2 } });
    expect(a.outcomes.coverage).toBeCloseTo(4 / 6);
    expect(a.corrections).toMatchObject({ open: 2, staged: 1 });
    expect(a.corrections.items.map((c) => c.title)).toEqual(['Offer reversal first', 'Stop promising 24h', 'Escalate hardship']);
    expect(a.corrections.insightCandidates.map((c) => c.key)).toEqual(['emi foreclosure']);
    expect(a.reviews).toMatchObject({ inWindow: 1, items: [expect.objectContaining({ customerName: 'Priya Deshmukh', reviewerName: 'Anjali Rao', score: 4, outcomeTag: 'good handoff', topic: 'Refund request' })] });
    expect(a.salesOutcomes).toBeNull();
  });

  it('returns a 14-day series with prompt-version activation markers', async () => {
    const a = await new AgentAnalyticsService(t.db, () => now).analytics(lead, id.maya!, 7);
    expect(a.series.points).toHaveLength(14);
    expect(a.series.points.reduce((s, p) => s + p.conversations, 0)).toBe(8);
    expect(a.series.promptVersions).toEqual([expect.objectContaining({ version: 2, reason: 'reason v2', agentName: 'Maya' })]);
  });

  it('aggregates every agent and reports sales outcomes as codes', async () => {
    const all = await new AgentAnalyticsService(t.db, () => now).analytics(lead, null, 7);
    expect(all.tiles.conversations.value).toBe(9);
    expect(all.salesOutcomes!.items.map((s) => `${s.outcome}:${s.count}`).sort()).toEqual(['CONVERTED:1', 'NOT_INTERESTED:1']);
  });

  it('compares agents and ranks escalations', async () => {
    const c = await agentComparison(t.db, lead, 7, now);
    expect(c.agents.map((a) => a.name)).toEqual(['Arjun', 'Maya']);
    expect(c.agents[0]).toMatchObject({ conversations: 3, escalated: 1, topEscalationReason: 'pricing_exception' });
    expect(c.agents[1]).toMatchObject({ conversations: 6, escalated: 2, slaBreaches: 2, csat: 4, costPerConversationMicros: 100 });
    expect(c.escalationRanking.map((r) => r.name)).toEqual(['Maya', 'Arjun']);
  });

  it('keeps agentSummaries containment consistent with the documented formula', async () => {
    const s = (await agentSummaries(t.db, 7)).get(id.maya!)!;
    expect(s.containmentRate).toBeCloseTo(3 / 6);
    expect(s.escalationRate).toBeCloseTo(2 / 6);
  });

  it('denies analytics to execs and tech admins', async () => {
    const svc = new AgentAnalyticsService(t.db, () => now);
    await expect(svc.analytics(exec, id.maya!, 7)).rejects.toMatchObject({ category: 'authorization' });
    await expect(svc.analytics(admin, null, 7)).rejects.toMatchObject({ category: 'authorization' });
    await expect(agentComparison(t.db, admin, 7)).rejects.toMatchObject({ category: 'authorization' });
    await expect(new QueueAnalyticsService(t.db).list(exec)).rejects.toMatchObject({ category: 'authorization' });
  });
});

describe('queue analytics', () => {
  it('reports waiting, staffing, wait time and an explicit state per queue', async () => {
    const { queues: rows } = await new QueueAnalyticsService(t.db, () => now).list(lead, 7);
    const cards = rows.find((q) => q.name === 'Cards & EMI')!;
    // members: the exec and the lead (the lead joined the team that owns the agents).
    expect(cards).toMatchObject({ waiting: 1, onShift: 1, members: 2, breaches: 1, slaBreachesInWindow: 1, avgWaitSeconds: 60, pickedUp: 1, state: 'watch' });
    expect(rows.find((q) => q.name === 'Hardship desk')).toMatchObject({ waiting: 1, onShift: 0, state: 'understaffed' });
  });
});

describe('home', () => {
  it('gives execs their queue, work and personal stats — no technical telemetry', async () => {
    const home = await new HomeService(t.db, {}, () => now).home(exec);
    expect(home.role).toBe('CS_EXEC');
    if (home.role !== 'CS_EXEC') return;
    expect(home.exec.tiles).toEqual({ assignedToMe: 1, waitingForHuman: 1, slaBreached: 1, resolvedToday: 1, myFirstResponseMedianSeconds: 10, myCsat7d: { average: 3, responses: 1 } });
    expect(home.exec.pickupQueue).toEqual([expect.objectContaining({ conversationId: id.c3, customerName: 'Farida Sheikh', reason: 'customer asked for a human', priority: 'P1', queueName: 'Cards & EMI' })]);
    expect(home.exec.pickupQueue[0]!.identity).not.toMatch(/\d{8}/);
    expect(home.exec.assigned).toEqual([expect.objectContaining({ conversationId: id.c4, controlState: 'HUMAN_ACTIVE', lastPreview: 'card replacement courier' })]);
    expect(home.exec.shift).toMatchObject({ availability: 'AVAILABLE', activeConversations: 1, queues: [{ id: id.q1, name: 'Cards & EMI' }], languages: ['en', 'mr'] });
    expect(home.exec.forYou.map((f) => f.kind).sort()).toEqual(['alert', 'urgent_pickup']);
    expect(home.exec.recentlyResolved).toEqual([expect.objectContaining({ conversationId: id.c2, topic: 'Refund request', csat: 3 })]);
    const json = JSON.stringify(home);
    expect(json).not.toContain('TTFT above SLO');
    expect(json).not.toContain('Hardship desk');
  });

  it('gives leads agent cards, queues and decisions', async () => {
    const home = await new HomeService(t.db, {}, () => now).home(lead);
    if (home.role !== 'CS_LEAD') throw new Error('expected lead home');
    expect(home.lead.tiles).toMatchObject({ conversations: 9, slaBreaches: 2, correctionsOpen: 2, correctionsStaged: 1 });
    expect(home.lead.tiles.escalationRate).toBeCloseTo(3 / 9);
    const maya = home.lead.agents.find((a) => a.name === 'Maya')!;
    expect(maya).toMatchObject({ promptVersion: 2, conversations: 6, slaBreaches: 2, openAlerts: 1, channels: [{ kind: 'WEBCHAT', name: 'Web chat' }, { kind: 'WHATSAPP', name: 'WhatsApp' }] });
    expect(home.lead.decisions).toEqual(
      expect.arrayContaining([
        { kind: 'prompt_corrections', agentId: id.maya, agentName: 'Maya', open: 2, staged: 1 },
        expect.objectContaining({ kind: 'understaffed_queue', queueName: 'Hardship desk', waiting: 1, onShift: 0 }),
      ]),
    );
    expect(home.lead.decisions.some((d) => d.kind === 'escalation_spike')).toBe(false); // below the 20-conversation minimum
    expect(home.lead.escalationReasons.map((r) => r.reasonCode)).toContain('pricing_exception');
  });

  it('gives tech admins platform health only — no conversation content', async () => {
    const home = await new HomeService(t.db, {}, () => now).home(admin);
    if (home.role !== 'PLATFORM_TECH_ADMIN') throw new Error('expected admin home');
    expect(home.admin.tiles).toMatchObject({ activeConversations: 4, openIncidents: 1 }); // c3, c4, c5, c11
    expect(home.admin.incidents).toMatchObject({ open: 1, critical: 1, items: [expect.objectContaining({ title: 'TTFT above SLO' })] });
    expect(home.admin.connections.channels).toEqual({ channels: 2, active: 2, failedDeliveries1h: 0 });
    const json = JSON.stringify(home);
    for (const secret of ['Farida', 'Priya', 'Suresh', 'I want to talk', 'refund above authority', 'card replacement courier', 'Escalation rate above']) {
      expect(json).not.toContain(secret);
    }
  });
});
