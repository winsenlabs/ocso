import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { agentTeams, alerts, approvalProposals, conversations, customers, queueTeams, queues, teamMembers, teams, users, uuidv7, virtualAgents } from '@ocso/db';
import { addUserWithPassword, completeSetup, startApi, type ApiHarness } from './harness.js';

/**
 * GET /v1/home, the HOME contract end to end per role: the ranked "needs you" list (only what the caller may
 * act on, in their teams), trend tiles, the service flow and setup checklist (Tech, Head, Lead), take next
 * (Service), no conversation content for Tech, and the 15 s per-user cache with Cache-Control: no-cache.
 */
let h: ApiHarness;
const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const tokens: Record<'tech' | 'head' | 'lead' | 'service' | 'otherHead', string> = { tech: '', head: '', lead: '', service: '', otherHead: '' };
const id: Record<string, string> = {};
const PASSWORD = 'a password 12345';
const NEEDS_YOU_KINDS = ['approval_to_decide', 'proposal_returned', 'escalation_waiting', 'sla_at_risk', 'alert', 'exception', 'channel_down', 'provider_down', 'grant_expiring', 'routing_stuck', 'setup'];

interface Item {
  id: string;
  kind: string;
  severity: string;
  title: string;
  at: string;
  href: string;
  askOcso?: string;
}
const itemIds = (body: { needsYou: Item[] }) => body.needsYou.map((i) => i.id);
const home = (token: string, fresh = true) => h.http().get('/v1/home').set({ ...auth(token), ...(fresh ? { 'cache-control': 'no-cache' } : {}) }).expect(200);

beforeAll(async () => {
  h = await startApi();
  tokens.tech = await completeSetup(h);
  const db = h.db.db;
  for (const [key, role] of [['head', 'HEAD'], ['lead', 'LEAD'], ['service', 'SERVICE'], ['otherHead', 'HEAD']] as const) {
    id[key] = await addUserWithPassword(h, { email: `${key}@home.test`, name: key, role, password: PASSWORD });
    tokens[key] = await h.loginAs(`${key}@home.test`, PASSWORD);
  }
  await db.update(users).set({ availability: 'AVAILABLE', maxConcurrent: 3 }).where(eq(users.id, id.service!));
  id.cards = uuidv7();
  id.loans = uuidv7();
  await db.insert(teams).values([{ id: id.cards, name: 'Cards' }, { id: id.loans, name: 'Loans' }]);
  await db.insert(teamMembers).values([
    { teamId: id.cards, userId: id.head! },
    { teamId: id.cards, userId: id.lead! },
    { teamId: id.cards, userId: id.service! },
    { teamId: id.loans, userId: id.otherHead! },
  ]);
  id.maya = uuidv7();
  id.arjun = uuidv7();
  await db.insert(virtualAgents).values([
    { id: id.maya, name: 'Maya', slug: 'maya', conversationType: 'SUPPORT' },
    { id: id.arjun, name: 'Arjun', slug: 'arjun', conversationType: 'SALES' },
  ]);
  await db.insert(agentTeams).values([
    { agentId: id.maya, teamId: id.cards },
    { agentId: id.arjun, teamId: id.loans },
  ]);
  id.cardsQ = uuidv7();
  id.loansQ = uuidv7();
  await db.insert(queues).values([
    { id: id.cardsQ, name: 'Cards desk', agentId: id.maya },
    { id: id.loansQ, name: 'Loans desk', agentId: id.arjun },
  ]);
  await db.insert(queueTeams).values([
    { queueId: id.cardsQ, teamId: id.cards },
    { queueId: id.loansQ, teamId: id.loans },
  ]);
  const waiting = async (key: string, agentId: string, queueId: string, customer: string) => {
    const customerId = uuidv7();
    await db.insert(customers).values({ id: customerId, displayName: customer });
    id[key] = uuidv7();
    const since = new Date(Date.now() - 20 * 60_000);
    await db.insert(conversations).values({ id: id[key]!, customerId, agentId, queueId, type: 'SUPPORT', controlState: 'WAITING_FOR_HUMAN', waitingSince: since, openedAt: since, lastInteractionAt: since, priority: 'P1' });
  };
  await waiting('cardsConv', id.maya, id.cardsQ, 'Priya Deshmukh');
  await waiting('loansConv', id.arjun, id.loansQ, 'Imran Shaikh');

  // Approvals on agents (approvals.check.agents): one for the Head, one naming the Lead (who cannot check), one for the other team.
  const propose = async (key: string, maker: string, checker: string, teamId: string, title: string) => {
    id[key] = uuidv7();
    await db.insert(approvalProposals).values({ id: id[key]!, objectKind: 'agent', objectId: uuidv7(), action: 'UPDATE', contentHash: 'c', dependencyHash: 'd', teamIds: [teamId], title, reason: 'r', makerId: id[maker]!, checkerId: id[checker]! });
  };
  await propose('forHead', 'lead', 'head', id.cards, 'Maya greeting');
  await propose('forLead', 'head', 'lead', id.cards, 'Maya hours');
  await propose('forOther', 'otherHead', 'head', id.loans, 'Arjun tone');

  await db.insert(alerts).values([
    { id: uuidv7(), fingerprint: 'biz', kind: 'BUSINESS', severity: 'WARNING', title: 'Escalations up on Maya', body: 'b', audienceRoles: ['HEAD', 'LEAD', 'SERVICE'], source: 'test', context: { agentId: id.maya } },
    { id: uuidv7(), fingerprint: 'tech', kind: 'TECHNICAL', severity: 'CRITICAL', title: 'Workers below minimum', body: 'b', audienceRoles: ['TECH'], source: 'test' },
  ]);
}, 120_000);

afterAll(async () => {
  await h?.close();
});

describe('GET /v1/home', () => {
  it('Tech: platform tiles, the whole flow, setup, technical items only, no conversation content', async () => {
    const started = Date.now();
    const res = await home(tokens.tech);
    const elapsed = Date.now() - started;
    expect(res.body.role).toBe('TECH');
    expect(res.body.admin).toBeDefined(); // the existing surface stays for one release
    expect(res.body.tiles.map((t: { key: string }) => t.key)).toEqual(['uptime', 'ttft_p95', 'model_errors', 'incidents', 'tokens', 'open_incidents']);
    expect(res.body.flow.agents.map((a: { name: string }) => a.name)).toEqual(['Arjun', 'Maya']);
    expect(res.body.flow.queues.map((q: { name: string; waiting: number }) => [q.name, q.waiting])).toEqual([
      ['Cards desk', 1],
      ['Loans desk', 1],
    ]);
    expect(res.body.setup.steps.map((s: { key: string }) => s.key)).toEqual(['model', 'agent', 'channel', 'second_checker', 'go_live', 'ask_ocso']);
    expect(res.body.setup.complete).toBe(false);
    const kinds = res.body.needsYou.map((i: Item) => i.kind);
    for (const k of kinds) expect(NEEDS_YOU_KINDS).toContain(k);
    expect(res.body.needsYou.find((i: Item) => i.kind === 'alert')).toMatchObject({ severity: 'critical', title: 'Workers below minimum', href: expect.stringMatching(/^\/alerts\?alert=/) });
    expect(res.body.needsYou.map((i: Item) => i.severity)).toEqual([...res.body.needsYou.map((i: Item) => i.severity)].sort((a, b) => ['critical', 'high', 'normal'].indexOf(a) - ['critical', 'high', 'normal'].indexOf(b)));
    expect(kinds).not.toContain('escalation_waiting');
    expect(kinds).not.toContain('approval_to_decide');
    const json = JSON.stringify(res.body);
    expect(json).not.toContain('Priya');
    expect(json).not.toContain('Imran');
    expect(res.body.service).toBeUndefined();
    // Informational: the demo-sized budget is 300 ms on a warm server.
    expect(elapsed).toBeLessThan(5_000);
  });

  it('Head: approvals they check, their teams’ queues and agents, alerts about their agents; nothing of another team', async () => {
    const res = await home(tokens.head);
    expect(res.body.role).toBe('HEAD');
    expect(res.body.lead).toBeDefined();
    const ids = itemIds(res.body);
    expect(ids).toContain(`approval:${id.forHead}`);
    expect(ids).toContain(`approval:${id.forOther}`); // named checker of another team's proposal: theirs to decide
    expect(ids).not.toContain(`approval:${id.forLead}`);
    expect(res.body.needsYou.find((i: Item) => i.id === `approval:${id.forHead}`)).toMatchObject({ href: `/approvals?approval=${id.forHead}`, askOcso: expect.stringContaining('Maya greeting') });
    expect(res.body.needsYou.find((i: Item) => i.id === `queue:${id.cardsQ}`)).toMatchObject({ kind: 'escalation_waiting', title: '1 waiting in Cards desk' });
    expect(ids).not.toContain(`queue:${id.loansQ}`);
    expect(res.body.needsYou.some((i: Item) => i.title === 'Escalations up on Maya')).toBe(true);
    expect(res.body.flow.agents.map((a: { name: string }) => a.name)).toEqual(['Maya']);
    expect(res.body.flow.queues.map((q: { name: string }) => q.name)).toEqual(['Cards desk']);
    expect(res.body.tiles.map((t: { key: string }) => t.key)).toEqual(['conversations', 'containment', 'escalation', 'sla_breaches', 'csat']);
    expect(res.body.setup).toBeDefined();
    expect(JSON.stringify(res.body.needsYou)).not.toContain('Imran');

    const other = await home(tokens.otherHead);
    expect(itemIds(other.body)).not.toContain(`approval:${id.forHead}`);
    expect(other.body.needsYou.some((i: Item) => i.title === 'Escalations up on Maya')).toBe(false);
    expect(other.body.flow.agents.map((a: { name: string }) => a.name)).toEqual(['Arjun']);
  });

  it('Lead: the Head surface, but never an approval they cannot check', async () => {
    const res = await home(tokens.lead);
    expect(res.body.role).toBe('HEAD');
    const kinds = res.body.needsYou.map((i: Item) => i.kind);
    expect(kinds).not.toContain('approval_to_decide');
    expect(kinds).not.toContain('exception'); // no exceptions.read
    expect(itemIds(res.body)).toContain(`queue:${id.cardsQ}`);
  });

  it('Service: take next, my queue, conversations waiting in my team’s queue; no flow or setup', async () => {
    const res = await home(tokens.service);
    expect(res.body.role).toBe('SERVICE');
    expect(res.body.flow).toBeUndefined();
    expect(res.body.setup).toBeUndefined();
    expect(res.body.service).toMatchObject({ nextAvailable: true, next: { conversationId: id.cardsConv, customerName: 'Priya Deshmukh', priority: 'P1' } });
    expect(res.body.service.myQueue).toEqual(res.body.exec.pickupQueue);
    expect(res.body.needsYou.find((i: Item) => i.id === `conversation:${id.cardsConv}`)).toMatchObject({ kind: 'escalation_waiting', severity: 'high', href: `/conversations/${id.cardsConv}` });
    expect(itemIds(res.body)).not.toContain(`conversation:${id.loansConv}`);
    expect(res.body.needsYou.map((i: Item) => i.kind)).not.toContain('approval_to_decide');
    expect(res.body.tiles.find((t: { key: string }) => t.key === 'resolved_today')).toMatchObject({ period: 'today', betterWhen: 'up' });
  });

  it('caches 15 s per user; Cache-Control: no-cache reads fresh', async () => {
    const first = await home(tokens.service);
    const alertTitle = `Fresh alert ${Date.now()}`;
    await h.db.db.insert(alerts).values({ id: uuidv7(), fingerprint: alertTitle, kind: 'BUSINESS', severity: 'CRITICAL', title: alertTitle, body: 'b', audienceRoles: ['SERVICE'], source: 'test' });
    const cached = await home(tokens.service, false);
    expect(cached.body.generatedAt).toBe(first.body.generatedAt);
    expect(cached.body.needsYou.some((i: Item) => i.title === alertTitle)).toBe(false);
    const fresh = await home(tokens.service);
    expect(fresh.body.needsYou.some((i: Item) => i.title === alertTitle && i.severity === 'critical')).toBe(true);
    // Another user never shares the entry.
    const head = await home(tokens.head, false);
    expect(head.body.role).toBe('HEAD');
  });

  it('401 without a session', async () => {
    await h.http().get('/v1/home').expect(401);
  });
});
