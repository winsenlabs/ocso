import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from '@ocso/db/testing';
import {
  agentTeams,
  alerts,
  approvalProposals,
  auditEvents,
  channels,
  conversationRouting,
  conversations,
  customers,
  deploymentSettings,
  healthSampleRollups,
  healthSamples,
  modelProfiles,
  modelProviders,
  queueTeams,
  queues,
  slaPolicies,
  teamMembers,
  teams,
  userPermissionGrants,
  users,
  uuidv7,
  virtualAgents,
} from '@ocso/db';
import { Permission, type Principal } from '@ocso/auth';
import type { RouterDefinition } from '@ocso/domain';
import { AVAILABILITY_COMPONENT, HomeService, rankNeedsYou, routeChannelToAgent, systemActor, techTiles, type ExceptionReportContent, type HomeView, type NeedsYouItem } from '../src/index.js';
import { setupItems } from '../src/analytics/home-needs-you-derived.js';
import { createRoutingFixture, type RoutingFixture } from './support/routing-fixture.js';

/**
 * The Home contract (HOME.md): "needs you" (only what the person may act on, in scope, ranked), trend tiles
 * with the previous period, the service flow, the setup checklist, take next and the per-user cache.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
// A fixed clock at midday UTC (the deployment timezone is UTC): today and yesterday are unambiguous.
const NOW = new Date('2026-09-24T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const later = (ms: number) => new Date(NOW.getTime() + ms);

const strict = (extra: ConstructorParameters<typeof HomeService>[1] = {}) =>
  new HomeService(
    t.db,
    {
      cacheMs: 0,
      onError: (source, err) => {
        throw new Error(`home source ${source} failed: ${String(err)}`);
      },
      ...extra,
    },
    () => NOW,
  );
const kinds = (items: NeedsYouItem[]) => items.map((i) => i.kind);
const ids = (items: NeedsYouItem[]) => items.map((i) => i.id);
const tile = (home: HomeView, key: string) => home.tiles.find((x) => x.key === key);

let t: TestDatabase;
const id: Record<string, string> = {};
const P = (key: string, role: Principal['role'], teamIds: string[] = []): Principal => ({ userId: id[key]!, role, displayName: key, teamIds, via: 'UI' });
let headA: Principal;
let headB: Principal;
let service: Principal;
let tech: Principal;

async function conversation(key: string, o: { agent: string; queue?: string; state: string; opened?: Date; assigned?: string; waitingSince?: Date; slaDueAt?: Date; priority?: 'P1' | 'P2' | 'P3' | 'P4'; customer?: string }) {
  const customerId = uuidv7();
  await t.db.insert(customers).values({ id: customerId, displayName: o.customer ?? `Customer ${key}` });
  id[key] = uuidv7();
  await t.db.insert(conversations).values({
    id: id[key]!,
    customerId,
    agentId: id[o.agent]!,
    type: 'SUPPORT',
    controlState: o.state,
    queueId: o.queue ? id[o.queue]! : null,
    assignedUserId: o.assigned ? id[o.assigned]! : null,
    openedAt: o.opened ?? ago(HOUR),
    lastInteractionAt: o.opened ?? ago(HOUR),
    waitingSince: o.waitingSince ?? null,
    slaDueAt: o.slaDueAt ?? null,
    priority: o.priority ?? 'P3',
  });
}

async function proposal(o: { key: string; status: string; maker: string; checker: string; teamIds: string[]; title: string; submittedAt?: Date; decidedAt?: Date }) {
  id[o.key] = uuidv7();
  await t.db.insert(approvalProposals).values({
    id: id[o.key]!,
    objectKind: 'agent',
    objectId: uuidv7(),
    action: 'UPDATE',
    contentHash: 'c',
    dependencyHash: 'd',
    teamIds: o.teamIds,
    title: o.title,
    reason: 'because',
    makerId: id[o.maker]!,
    checkerId: id[o.checker]!,
    submittedAt: o.submittedAt ?? ago(HOUR),
  });
  // A proposal is created SUBMITTED (a trigger enforces it); a decision moves it on.
  if (o.status !== 'SUBMITTED') {
    await t.db
      .update(approvalProposals)
      .set({ status: o.status as 'REJECTED', decidedAt: o.decidedAt ?? NOW, decidedBy: id[o.checker]!, decisionReason: 'Not now' })
      .where(eq(approvalProposals.id, id[o.key]!));
  }
}

async function resolvedBy(user: string, at: Date) {
  await t.db.insert(auditEvents).values({ id: uuidv7(), occurredAt: at, actorType: 'USER', actorId: id[user]!, via: 'UI', action: 'conversation.resolve', targetType: 'conversation', targetId: uuidv7(), summary: 'resolved' });
}

beforeAll(async () => {
  t = await createTestDatabase();
  await t.db.update(deploymentSettings).set({ timezone: 'UTC' });
  for (const [key, role] of [['headA', 'HEAD'], ['headB', 'HEAD'], ['service', 'SERVICE'], ['serviceB', 'SERVICE'], ['tech', 'TECH']] as const) {
    id[key] = uuidv7();
    await t.db.insert(users).values({ id: id[key]!, email: `${key}@home.test`, name: key, role, availability: 'AVAILABLE', maxConcurrent: 3 });
  }
  id.teamA = uuidv7();
  id.teamB = uuidv7();
  await t.db.insert(teams).values([{ id: id.teamA, name: 'Cards' }, { id: id.teamB, name: 'Loans' }]);
  await t.db.insert(teamMembers).values([
    { teamId: id.teamA, userId: id.headA! },
    { teamId: id.teamA, userId: id.service! },
    { teamId: id.teamB, userId: id.headB! },
    { teamId: id.teamB, userId: id.serviceB! },
  ]);
  headA = P('headA', 'HEAD', [id.teamA]);
  headB = P('headB', 'HEAD', [id.teamB]);
  service = P('service', 'SERVICE', [id.teamA]);
  tech = P('tech', 'TECH');

  for (const k of ['agentA', 'agentB']) {
    id[k] = uuidv7();
    await t.db.insert(virtualAgents).values({ id: id[k]!, name: k === 'agentA' ? 'Maya' : 'Arjun', slug: k, conversationType: 'SUPPORT' });
  }
  await t.db.insert(agentTeams).values([
    { agentId: id.agentA!, teamId: id.teamA! },
    { agentId: id.agentB!, teamId: id.teamB! },
  ]);
  id.sla = uuidv7();
  await t.db.insert(slaPolicies).values({ id: id.sla, name: 'Standard', atRiskFraction: 0.5 });
  id.queueA = uuidv7();
  id.queueB = uuidv7();
  await t.db.insert(queues).values([
    { id: id.queueA, name: 'Cards desk', agentId: id.agentA!, slaPolicyId: id.sla },
    { id: id.queueB, name: 'Loans desk', agentId: id.agentB! },
  ]);
  await t.db.insert(queueTeams).values([
    { queueId: id.queueA!, teamId: id.teamA! },
    { queueId: id.queueB!, teamId: id.teamB! },
  ]);

  // Waiting conversations: at SLA risk (10 of 15 minutes gone, at-risk fraction 0.5), offered to the Service member, another team's.
  await conversation('atRisk', { agent: 'agentA', queue: 'queueA', state: 'WAITING_FOR_HUMAN', waitingSince: ago(10 * MIN), slaDueAt: later(5 * MIN), customer: 'Priya' });
  await conversation('offered', { agent: 'agentA', queue: 'queueA', state: 'WAITING_FOR_HUMAN', waitingSince: ago(20 * MIN), assigned: 'service', customer: 'Rahul' });
  await conversation('otherTeam', { agent: 'agentB', queue: 'queueB', state: 'WAITING_FOR_HUMAN', waitingSince: ago(30 * MIN), slaDueAt: ago(MIN), customer: 'Imran' });
  // For the 7-day trend: one more this week for agent A, two in the week before.
  await conversation('week', { agent: 'agentA', state: 'RESOLVED', opened: ago(3 * DAY) });
  await conversation('prev1', { agent: 'agentA', state: 'RESOLVED', opened: ago(9 * DAY) });
  await conversation('prev2', { agent: 'agentA', state: 'RESOLVED', opened: ago(10 * DAY) });

  // Approvals: one waiting on headA, one on headB (other team), one returned to headA recently, one long ago.
  await proposal({ key: 'pA', status: 'SUBMITTED', maker: 'headB', checker: 'headA', teamIds: [id.teamA!], title: 'Maya tone', submittedAt: ago(5 * DAY) });
  await proposal({ key: 'pB', status: 'SUBMITTED', maker: 'headA', checker: 'headB', teamIds: [id.teamB!], title: 'Arjun tone' });
  await proposal({ key: 'pReturned', status: 'REJECTED', maker: 'headA', checker: 'headB', teamIds: [id.teamA!], title: 'Maya hours', decidedAt: ago(DAY) });
  await proposal({ key: 'pOld', status: 'REJECTED', maker: 'headA', checker: 'headB', teamIds: [id.teamA!], title: 'Maya greeting', decidedAt: ago(10 * DAY) });

  // Alerts: business critical for everyone, a Tech-only warning, one about team B's agent, an old resolved technical one.
  const alert = (key: string, v: Partial<typeof alerts.$inferInsert>) => {
    id[key] = uuidv7();
    return t.db.insert(alerts).values({ id: id[key]!, fingerprint: key, kind: 'BUSINESS', severity: 'CRITICAL', title: key, body: key, audienceRoles: ['HEAD', 'LEAD', 'SERVICE'], source: 'test', openedAt: ago(2 * HOUR), ...v });
  };
  await alert('alertAll', {});
  await alert('alertTech', { kind: 'TECHNICAL', severity: 'WARNING', audienceRoles: ['TECH'], openedAt: ago(HOUR) });
  await alert('alertAgentB', { severity: 'WARNING', audienceRoles: ['HEAD'], context: { agentId: id.agentB } });
  await alert('alertOldTech', { kind: 'TECHNICAL', severity: 'INFO', audienceRoles: ['TECH'], status: 'RESOLVED', openedAt: ago(10 * DAY) });

  // Grants: the Service member's extra access ends in 12 hours; another in a month.
  await t.db.insert(userPermissionGrants).values([
    { id: uuidv7(), userId: id.service!, permission: 'conversations.assign', effect: 'GRANT', expiresAt: later(12 * HOUR), reason: 'cover' },
    { id: uuidv7(), userId: id.service!, permission: 'customers.manage', effect: 'GRANT', expiresAt: later(30 * DAY), reason: 'cover' },
  ]);

  // Resolved by the Service member: two today, one yesterday morning, one yesterday afternoon (after "now" of day).
  await resolvedBy('service', ago(2 * HOUR));
  await resolvedBy('service', ago(HOUR));
  await resolvedBy('service', ago(DAY + 3 * HOUR));
  await resolvedBy('service', ago(DAY - 2 * HOUR));
});

afterAll(async () => {
  await t?.drop();
});

describe('needs you', () => {
  it('ranks by severity, then earliest due or oldest, and caps at 20', () => {
    const item = (id: string, severity: NeedsYouItem['severity'], at: string): NeedsYouItem => ({ id, kind: 'alert', severity, title: id, at, href: '/' });
    const ranked = rankNeedsYou([
      item('n-late', 'normal', '2026-09-24T10:00:00Z'),
      item('h-late', 'high', '2026-09-24T11:00:00Z'),
      item('c', 'critical', '2026-09-24T11:30:00Z'),
      item('h-early', 'high', '2026-09-24T09:00:00Z'),
      item('n-early', 'normal', '2026-09-24T08:00:00Z'),
    ]);
    expect(ranked.map((i) => i.id)).toEqual(['c', 'h-early', 'h-late', 'n-early', 'n-late']);
    expect(rankNeedsYou(Array.from({ length: 30 }, (_, i) => item(`x${i}`, 'normal', NOW.toISOString())))).toHaveLength(20);
  });

  it('Service: conversations in my queues or offered to me, alerts for my role, my expiring grants; nothing of other teams', async () => {
    const home = await strict().home(service);
    expect(home.role).toBe('SERVICE');
    const items = home.needsYou;
    expect(ids(items)).toEqual([`alert:${id.alertAll}`, `conversation:${id.offered}`, `conversation:${id.atRisk}`, expect.stringMatching(/^grant:/)]);
    expect(items[0]).toMatchObject({ kind: 'alert', severity: 'critical', href: `/alerts?alert=${id.alertAll}` });
    // Offered to me: high, dated from when it started waiting (older than the at-risk one's due time).
    expect(items[1]).toMatchObject({ kind: 'escalation_waiting', severity: 'high', title: 'Rahul is waiting for you', at: ago(20 * MIN).toISOString(), href: `/conversations/${id.offered}` });
    expect(items[2]).toMatchObject({ kind: 'sla_at_risk', severity: 'high', title: 'Priya: SLA at risk', at: later(5 * MIN).toISOString() });
    expect(items[2]!.askOcso).toMatch(/^Summarise conversation /);
    expect(items[3]).toMatchObject({ kind: 'grant_expiring', severity: 'high', href: '/account/security' });
    expect(kinds(items)).not.toContain('approval_to_decide'); // no check permission
    expect(JSON.stringify(items)).not.toContain('Imran');
  });

  it('Head: approvals I decide and my returned ones in scope, alerts about my agents only, queue waits of my teams, exceptions', async () => {
    const live = async (): Promise<{ content: ExceptionReportContent }> => ({
      content: {
        format: 'ocso-exception-report/2',
        kind: 'LIVE',
        period: { start: ago(7 * DAY).toISOString(), end: NOW.toISOString(), timezone: 'UTC' },
        generatedAt: NOW.toISOString(),
        sections: [
          { id: 'self_approval', label: 'Self-approvals', severity: 'critical', description: 'd', items: [], total: 2, truncated: false, scopes: [], coverage: null, error: null },
          { id: 'quiet', label: 'Nothing here', severity: 'high', description: 'd', items: [], total: 0, truncated: false, scopes: [], coverage: null, error: null },
          { id: 'broken', label: 'Broken check', severity: 'high', description: 'd', items: [], total: 0, truncated: false, scopes: [], coverage: null, error: 'timeout' },
        ],
        totals: { items: 2, bySeverity: { critical: 2, high: 0, medium: 0, low: 0 }, failedChecks: 1, truncatedChecks: 0, incompleteChecks: 0 },
      },
    });
    const home = await strict({ liveExceptions: live }).home(headA);
    expect(home.role).toBe('HEAD');
    const byId = new Map(home.needsYou.map((i) => [i.id, i]));
    // Waiting 5 days (past the 72 h warning): high.
    expect(byId.get(`approval:${id.pA}`)).toMatchObject({ kind: 'approval_to_decide', severity: 'high', href: `/approvals?approval=${id.pA}` });
    expect(byId.get(`proposal:${id.pReturned}`)).toMatchObject({ kind: 'proposal_returned', severity: 'normal', detail: 'Not now', href: `/approvals?box=sent&approval=${id.pReturned}` });
    expect(byId.has(`approval:${id.pB}`)).toBe(false); // someone else decides it
    expect(byId.has(`proposal:${id.pOld}`)).toBe(false); // returned too long ago
    expect(byId.has(`alert:${id.alertAll}`)).toBe(true);
    expect(byId.has(`alert:${id.alertAgentB}`)).toBe(false); // another team's agent
    expect(byId.has(`alert:${id.alertTech}`)).toBe(false);
    expect(byId.get('exception:self_approval')).toMatchObject({ kind: 'exception', severity: 'critical', title: 'Self-approvals: 2', href: '/exceptions' });
    expect(byId.has('exception:quiet')).toBe(false);
    expect(byId.has('exception:broken')).toBe(false);
    // The team's queue has a conversation at SLA risk: one item for the queue, never the customers.
    expect(byId.get(`queue:${id.queueA}`)).toMatchObject({ kind: 'sla_at_risk', severity: 'high', title: '1 of 2 waiting in Cards desk at SLA risk' });
    expect(byId.has(`queue:${id.queueB}`)).toBe(false);
    expect(JSON.stringify(home.needsYou)).not.toMatch(/Priya|Rahul|Imran/);
    expect(home.needsYou[0]!.severity).toBe('critical');

    const other = await strict({ liveExceptions: live }).home(headB);
    const otherIds = new Set(ids(other.needsYou));
    expect(otherIds.has(`approval:${id.pB}`)).toBe(true);
    expect(otherIds.has(`alert:${id.alertAgentB}`)).toBe(true);
    expect(otherIds.has(`approval:${id.pA}`)).toBe(false);
    // Past its SLA already: the Loans desk item is high, counted at risk.
    expect(other.needsYou.find((i) => i.id === `queue:${id.queueB}`)).toMatchObject({ kind: 'sla_at_risk' });
  });

  it('Tech: technical alerts, never conversations or business alerts; a failing source is reported, not fatal', async () => {
    const errors: string[] = [];
    const home = await new HomeService(t.db, { cacheMs: 0, liveExceptions: () => Promise.reject(new Error('boom')), onError: (s) => errors.push(s) }, () => NOW).home(tech);
    // The exception source failed: reported once, and every other source still shows.
    expect(errors).toEqual(['exceptions']);
    expect(home.role).toBe('TECH');
    const itemIds = ids(home.needsYou);
    expect(itemIds).toContain(`alert:${id.alertTech}`);
    expect(itemIds).not.toContain(`alert:${id.alertAll}`);
    expect(kinds(home.needsYou)).not.toContain('escalation_waiting');
    expect(kinds(home.needsYou)).not.toContain('sla_at_risk');
    // Service holds no exceptions.read: the source is never asked.
    await new HomeService(t.db, { cacheMs: 0, liveExceptions: () => Promise.reject(new Error('boom')), onError: (s) => errors.push(s) }, () => NOW).home(service);
    expect(errors).toEqual(['exceptions']);
  });
});

describe('trend tiles', () => {
  it('Service: today vs yesterday to the same time, live counts without a previous', async () => {
    const home = await strict().home(service);
    expect(home.tiles.length).toBeGreaterThanOrEqual(4);
    expect(home.tiles.length).toBeLessThanOrEqual(6);
    expect(tile(home, 'resolved_today')).toMatchObject({ value: 2, previous: 1, betterWhen: 'up', period: 'today', unit: 'count' });
    // Waiting in my team's queue: the unassigned one and the one offered to me (another team's is not counted).
    expect(tile(home, 'waiting')).toMatchObject({ value: 2, previous: null, period: 'now', betterWhen: 'down' });
  });

  it('Head: the last 7 days vs the 7 before, over my teams’ agents', async () => {
    const home = await strict().home(headA);
    // atRisk, offered and week opened this week; prev1 and prev2 the week before (team B's are out of scope).
    expect(tile(home, 'conversations')).toMatchObject({ value: 3, previous: 2, betterWhen: 'none', period: '7d' });
    expect(tile(home, 'containment')).toMatchObject({ unit: '%', betterWhen: 'up' });
    expect(tile(home, 'escalation')).toMatchObject({ unit: '%', betterWhen: 'down' });
  });

  it('Tech: incidents opened this week vs the week before, ratios as 0–1', async () => {
    const home = await strict().home(tech);
    expect(tile(home, 'incidents')).toMatchObject({ value: 1, previous: 1, betterWhen: 'down', period: '7d' });
    expect(tile(home, 'open_incidents')).toMatchObject({ value: 1, previous: null, period: 'now' });
    for (const x of home.tiles.filter((x) => x.unit === '%' && x.value !== null)) expect(x.value).toBeLessThanOrEqual(1);
  });
});

describe('service section', () => {
  it('take next offers the first unassigned conversation in my queues while I have room', async () => {
    const home = await strict().home(service);
    if (home.role !== 'SERVICE') throw new Error('expected the Service surface');
    expect(home.service).toMatchObject({ nextAvailable: true, next: { conversationId: id.atRisk, customerName: 'Priya' } });
    expect(home.service.myShift).toEqual(home.exec.shift);
    expect(home.service.myQueue).toEqual(home.exec.pickupQueue);
    // At my concurrency limit: nothing to take.
    await t.db.update(users).set({ maxConcurrent: 1 }).where(eq(users.id, id.service!));
    const full = await strict().home(service);
    if (full.role !== 'SERVICE') throw new Error('expected the Service surface');
    expect(full.service.nextAvailable).toBe(false);
    await t.db.update(users).set({ maxConcurrent: 3 }).where(eq(users.id, id.service!));
  });
});

describe('setup checklist', () => {
  it('tracks each step from live state and becomes complete; Tech is pointed at the next step they can do', async () => {
    const before = await strict().home(tech);
    if (before.role !== 'TECH') throw new Error('expected the Tech surface');
    const done = (h: typeof before) => Object.fromEntries(h.setup.steps.map((s) => [s.key, s.done]));
    expect(done(before)).toEqual({ model: false, agent: true, channel: false, second_checker: true, go_live: false, ask_ocso: false });
    expect(before.setup.complete).toBe(false);
    expect(before.needsYou.find((i) => i.kind === 'setup')).toMatchObject({ id: 'setup:model', href: '/connections?tab=providers' });
    // A Head is told about the steps but can do none of the next ones Tech owns: the first they can do is "go live".
    const head = await strict().home(headA);
    expect(head.needsYou.filter((i) => i.kind === 'setup').map((i) => i.id)).toEqual(['setup:go_live']);

    const providerId = uuidv7();
    const profileId = uuidv7();
    await t.db.insert(modelProviders).values({ id: providerId, kind: 'DEV_SCRIPTED', name: 'Scripted', residencyZone: 'IN' });
    await t.db.insert(modelProfiles).values({ id: profileId, name: 'default', providerId, model: 'scripted' });
    const channelId = uuidv7();
    await t.db.insert(channels).values({ id: channelId, kind: 'WEBCHAT', name: 'Web', status: 'ACTIVE', publicKey: 'pk-home-setup' });
    await t.db.update(virtualAgents).set({ status: 'LIVE' }).where(eq(virtualAgents.id, id.agentA!));
    await routeChannelToAgent(t.db, systemActor('test', 'test'), { channelId, agentId: id.agentA!, queueId: id.queueA! });
    await t.db.update(deploymentSettings).set({ internalAgentProfileId: profileId });
    const after = await strict().home(tech);
    if (after.role !== 'TECH') throw new Error('expected the Tech surface');
    expect(done(after)).toEqual({ model: true, agent: true, channel: true, second_checker: true, go_live: true, ask_ocso: true });
    expect(after.setup.complete).toBe(true);
    expect(kinds(after.needsYou)).not.toContain('setup');
  });
});

describe('cache', () => {
  it('serves the same answer for 15 s per user, and reads fresh on request', async () => {
    const home = new HomeService(t.db, {}, () => NOW);
    const first = await home.home(service);
    const alertId = uuidv7();
    await t.db.insert(alerts).values({ id: alertId, fingerprint: 'cache', kind: 'BUSINESS', severity: 'WARNING', title: 'cache', body: 'b', audienceRoles: ['SERVICE'], source: 'test', openedAt: ago(MIN) });
    expect(await home.home(service)).toBe(first);
    const fresh = await home.home(service, { fresh: true });
    expect(ids(fresh.needsYou)).toContain(`alert:${alertId}`);
    // Another person, or the same person with other rights, never shares an entry.
    const otherTeams = await home.home({ ...service, teamIds: [] });
    expect(otherTeams).not.toBe(fresh);
    await t.db.delete(alerts).where(eq(alerts.id, alertId));
  });
});

describe('service flow on the routing fixture', () => {
  let f: RoutingFixture;
  const MENU: RouterDefinition = {
    steps: [
      {
        id: 'product',
        kind: 'ASK',
        attribute: 'product',
        prompt: { text: 'What can we help with?' },
        options: [
          { value: 'cards', label: 'Cards', synonyms: ['card'] },
          { value: 'sales', label: 'Loans', synonyms: ['loan'] },
        ],
        maxAttempts: 2,
        skipIfKnown: false,
      },
    ],
    rules: [{ when: { product: 'sales' }, queueId: 'SALES' }],
    fallbackQueueId: 'CARDS',
    returning: null,
    timeoutMinutes: 10,
  };
  beforeAll(async () => {
    f = await createRoutingFixture();
  });
  afterAll(async () => {
    await f?.drop();
  });

  it('shows channel → router → queue → agent with 24 h volumes, stuck routing and problems, scoped per role', async () => {
    const channel = await f.channelWith(MENU, 'Menu');
    // One conversation routed to Sales, one still routing long past the router's timeout.
    const routed = await f.say(channel, 'hi', '+919800200001');
    await f.engine.advance(routed.conversationId, 'r1');
    await f.say(channel, '2', '+919800200001');
    await f.engine.advance(routed.conversationId, 'r2');
    const stuck = await f.say(channel, 'hello', '+919800200002');
    await f.engine.advance(stuck.conversationId, 'r1');
    await f.t.db.update(conversationRouting).set({ awaitingSince: new Date(Date.now() - HOUR) }).where(eq(conversationRouting.conversationId, stuck.conversationId));
    // An active channel with no router: customers are turned away.
    await f.t.db.insert(channels).values({ id: uuidv7(), kind: 'WEBCHAT', name: 'Orphan', status: 'ACTIVE', publicKey: 'pk-orphan' });
    const [router] = (await f.t.db.execute<{ id: string }>(sql`SELECT router_id AS id FROM channels WHERE id = ${channel}::uuid`)).rows;

    const service = new HomeService(f.t.db, { cacheMs: 0, onError: (s, e) => { throw new Error(`${s}: ${String(e)}`); } });
    const lead = await service.home(f.lead);
    if (lead.role !== 'HEAD') throw new Error('expected the Head surface');
    expect(lead.flow.channels).toEqual([{ id: channel, name: 'Menu', kind: 'WHATSAPP', status: 'ACTIVE', conversations24h: 2 }]);
    expect(lead.flow.routers).toEqual([{ id: router!.id, name: 'Menu', status: 'ACTIVE', channelIds: [channel], routed24h: 1, stuck: 1 }]);
    expect(lead.flow.queues.map((q) => [q.name, q.routerIds, q.agentId])).toEqual([
      ['Cards', [router!.id], f.agents.maya],
      ['Sales', [router!.id], f.agents.arjun],
    ]);
    expect(lead.flow.agents.find((a) => a.id === f.agents.arjun)).toMatchObject({ name: 'Arjun', queueIds: [f.queues.sales], conversations24h: 1, containment: 1, escalations24h: 0 });
    expect(lead.needsYou.find((i) => i.kind === 'routing_stuck')).toMatchObject({ id: `router:${router!.id}`, severity: 'high', href: `/routers/${router!.id}` });
    expect(kinds(lead.needsYou)).not.toContain('channel_down'); // a Head does not manage channels

    const tech = await service.home({ userId: uuidv7(), role: 'TECH', displayName: 'Tech', teamIds: [], via: 'UI' });
    if (tech.role !== 'TECH') throw new Error('expected the Tech surface');
    expect(tech.flow.channels.find((c) => c.name === 'Orphan')).toMatchObject({ problem: 'No router: customers are turned away', conversations24h: 0 });
    expect(tech.needsYou.find((i) => i.kind === 'channel_down')).toMatchObject({ severity: 'critical', href: '/connections?tab=channels' });
    expect(JSON.stringify(tech.flow)).not.toContain('Priya');

    // A Head of a team that owns nothing here sees an empty flow.
    const outsider = await service.home({ userId: uuidv7(), role: 'HEAD', displayName: 'Other', teamIds: [uuidv7()], via: 'UI' });
    if (outsider.role !== 'HEAD') throw new Error('expected the Head surface');
    expect(outsider.flow).toEqual({ channels: [], routers: [], queues: [], agents: [] });
  });
});

describe('Tech uptime tile: previous week', () => {
  it('counts only the week before, never hours of the current week', async () => {
    // Raw samples are kept ~2 days, so the previous week comes only from hourly roll-ups: 10 up hours
    // in the week before, 10 down hours in the current week (which must not leak into "previous").
    const hourRow = (h: Date, up: number) => ({ hour: h, component: AVAILABILITY_COMPONENT, minutes: 60, upMinutes: up, lastDownAt: up < 60 ? h : null });
    const rows = [...Array.from({ length: 10 }, (_, i) => hourRow(ago(10 * DAY + i * HOUR), 60)), ...Array.from({ length: 10 }, (_, i) => hourRow(ago(3 * DAY + i * HOUR), 0))];
    await t.db.insert(healthSampleRollups).values(rows);
    const rawId = uuidv7();
    await t.db.insert(healthSamples).values({ id: rawId, component: 'database', status: 'OK', sampledAt: ago(HOUR) });
    try {
      const uptimeTile = (await techTiles(t.db, NOW)).find((x) => x.key === 'uptime');
      expect(uptimeTile?.previous).toBe(1);
      expect(uptimeTile?.value).not.toBeNull();
      expect(uptimeTile!.value!).toBeLessThan(1);
    } finally {
      await t.db.delete(healthSampleRollups).where(sql`${healthSampleRollups.component} = ${AVAILABILITY_COMPONENT}`);
      await t.db.delete(healthSamples).where(eq(healthSamples.id, rawId));
    }
  });
});

describe('setup step permissions', () => {
  it('Ask OCSO setup goes to deployment settings managers, not system.configure holders', () => {
    const setup = { complete: false, steps: [{ key: 'ask_ocso' as const, label: 'Choose the model Ask OCSO runs on', done: false, href: '/settings' }] };
    const who = (permissions: Permission[]): Principal => ({ userId: uuidv7(), role: 'TECH', displayName: 'x', teamIds: [], via: 'UI', permissions: new Set(permissions) });
    const input = (principal: Principal) => ({ principal, now: NOW }) as Parameters<typeof setupItems>[0];
    expect(setupItems(input(who([Permission.SYSTEM_CONFIGURE])), setup)).toEqual([]);
    expect(setupItems(input(who([Permission.DEPLOYMENT_SETTINGS_MANAGE])), setup).map((i) => i.id)).toEqual(['setup:ask_ocso']);
  });
});
