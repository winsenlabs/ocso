import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from '@ocso/db/testing';
import { auditEvents, cacheGenerations, conversations, customers, handoffs, queueTeams, queues, slaPolicies, teamMembers, teams, users, uuidv7, virtualAgents } from '@ocso/db';
import type { Principal } from '@ocso/auth';
import type { BusinessHoursInput } from '@ocso/domain';
import { AgentPatch, AgentService, autoAssignUnclaimed, expireOffers, requestHandoff, systemActor, type ActorContext, type HandoffRequest } from '../src/index.js';

/**
 * Agent business hours at runtime (docs/01 §4, docs/09 §3): the AI answers
 * 24×7, humans only inside `humanHours`. Out of hours a handoff still routes
 * to its queue, but offers and the pickup SLA clock start at the next opening.
 */

const lead: Principal = { userId: '00000000-0000-7000-8000-00000000001a', role: 'CS_LEAD', displayName: 'Anjali Rao', teamIds: [], via: 'UI' };
const leadCtx: ActorContext = { principal: lead, correlationId: 'hours-test' };
const EXEC_A = '00000000-0000-7000-8000-0000000000e1';
const EXEC_B = '00000000-0000-7000-8000-0000000000e2';
const HOURS: BusinessHoursInput = { timezone: 'Asia/Kolkata', humanHours: { mon: ['08:00', '23:00'], tue: ['08:00', '23:00'], wed: ['08:00', '23:00'], thu: ['08:00', '23:00'], fri: ['08:00', '23:00'] } };
const PICKUP_SLA = 300;

// Tuesday 22 Sep 2026 12:00 IST; 23:30 IST (closed); Wednesday 08:00 IST (next opening).
const IN_HOURS = new Date('2026-09-22T06:30:00Z');
const AFTER_CLOSE = new Date('2026-09-22T18:00:00Z');
const WED_OPEN = new Date('2026-09-23T02:30:00Z');
// Saturday 26 Sep → Monday 28 Sep 08:00 IST.
const SATURDAY = new Date('2026-09-26T06:00:00Z');
const MON_OPEN = new Date('2026-09-28T02:30:00Z');
const plus = (d: Date, seconds: number) => new Date(d.getTime() + seconds * 1000);

let t: TestDatabase;
let agentId: string;
let autoQueue: string;
let pickupQueue: string;

const handoffReq: HandoffRequest = { trigger: 'AGENT_DECISION', reasonCode: 'agent_decision', reasonText: 'refund above authority', priority: 'P2', requestedBy: { type: 'AGENT', id: null } };

async function conversation(queueId: string): Promise<string> {
  const customerId = uuidv7();
  const id = uuidv7();
  await t.db.insert(customers).values({ id: customerId, displayName: 'Priya Deshmukh' });
  await t.db.insert(conversations).values({ id, customerId, agentId, type: 'SUPPORT', queueId });
  return id;
}

const escalate = (conversationId: string, now: Date) => t.db.transaction((tx) => requestHandoff(tx, systemActor('test', 'hours-test'), conversationId, handoffReq, now));
const convOf = async (id: string) => (await t.db.select().from(conversations).where(eq(conversations.id, id)))[0]!;
const handoffOf = async (id: string) => (await t.db.select().from(handoffs).where(eq(handoffs.conversationId, id)))[0]!;
const setHours = (businessHours: unknown) => new AgentService(t.db).update(leadCtx, agentId, AgentPatch.parse({ businessHours }));

beforeAll(async () => {
  t = await createTestDatabase();
  await t.db.insert(users).values([
    { id: lead.userId, email: 'lead@x.test', name: 'Anjali Rao', role: 'CS_LEAD' },
    { id: EXEC_A, email: 'a@x.test', name: 'Nikhil', role: 'CS_EXEC', availability: 'AVAILABLE' },
    { id: EXEC_B, email: 'b@x.test', name: 'Farah', role: 'CS_EXEC', availability: 'AVAILABLE' },
  ]);
  const teamId = uuidv7();
  const slaId = uuidv7();
  autoQueue = uuidv7();
  pickupQueue = uuidv7();
  await t.db.insert(teams).values({ id: teamId, name: 'Cards' });
  await t.db.insert(teamMembers).values([{ teamId, userId: EXEC_A }, { teamId, userId: EXEC_B }]);
  await t.db.insert(slaPolicies).values({ id: slaId, name: 'Pickup 5m', pickupSecondsByPriority: { P2: PICKUP_SLA } });
  await t.db.insert(queues).values([
    { id: autoQueue, name: 'Cards · auto', mode: 'AUTO_ASSIGN', acceptTimeoutSeconds: 60, slaPolicyId: slaId },
    { id: pickupQueue, name: 'Cards · pickup', mode: 'OPEN_PICKUP', autoAssignAfterSeconds: 120, slaPolicyId: slaId },
  ]);
  await t.db.insert(queueTeams).values([{ queueId: autoQueue, teamId }, { queueId: pickupQueue, teamId }]);
  const agent = await new AgentService(t.db).create(leadCtx, { name: 'Maya', purpose: 'support', conversationType: 'SUPPORT', description: 'Cards and EMI questions', defaultQueueId: autoQueue, businessHours: HOURS });
  agentId = agent.id;
  await t.db.update(virtualAgents).set({ status: 'LIVE' }).where(eq(virtualAgents.id, agentId));
});
afterAll(async () => {
  await t?.drop();
});
beforeEach(async () => {
  // Each test starts with no open work so scheduler sweeps only see its own handoff.
  await t.pool.query(`UPDATE conversations SET control_state = 'RESOLVED', assigned_user_id = NULL WHERE control_state <> 'RESOLVED'`);
  await t.pool.query(`UPDATE handoffs SET status = 'RESOLVED', resolved_at = now() WHERE resolved_at IS NULL`);
});

describe('agent business hours: configuration', () => {
  it('stores hours on create and validates updates by path', async () => {
    expect((await convAgent()).businessHours).toEqual(HOURS);
    const bad = AgentPatch.safeParse({ businessHours: { timezone: 'Mars/Base', humanHours: { mon: ['18:00', '09:00'], xyz: ['09:00', '10:00'] } } });
    expect(bad.success).toBe(false);
    expect(bad.error!.issues.map((i) => i.path.join('.')).sort()).toEqual(['businessHours.humanHours', 'businessHours.humanHours.mon', 'businessHours.timezone']);
    const reversed = AgentPatch.safeParse({ businessHours: { timezone: 'UTC', humanHours: { mon: ['18:00', '09:00'] } } });
    expect(reversed.error!.issues).toEqual([expect.objectContaining({ path: ['businessHours', 'humanHours', 'mon'], message: 'Opening time must be before closing time' })]);
  });

  it('audits the change and bumps the agent cache generation', async () => {
    const scope = `agent:${agentId}`;
    const before = (await t.db.select().from(cacheGenerations).where(eq(cacheGenerations.scope, scope)))[0]?.generation ?? 1;
    await setHours({ timezone: 'UTC', humanHours: {} });
    await setHours(HOURS);
    const after = (await t.db.select().from(cacheGenerations).where(eq(cacheGenerations.scope, scope)))[0]!.generation;
    expect(after).toBe(before + 2);
    // A hours-only patch leaves every other field alone (no zod defaults inside the partial).
    expect(await convAgent()).toMatchObject({ name: 'Maya', purpose: 'support', description: 'Cards and EMI questions', businessHours: HOURS });
    expect(AgentPatch.parse({ businessHours: HOURS })).toEqual({ businessHours: HOURS });
    const audits = await t.db.select().from(auditEvents).where(and(eq(auditEvents.action, 'agent.update'), eq(auditEvents.targetId, agentId)));
    expect(audits.map((a) => a.summary)).toEqual(
      expect.arrayContaining(['Updated Maya · business hours humans 24×7', 'Updated Maya · business hours mon 08:00–23:00, tue 08:00–23:00, wed 08:00–23:00, thu 08:00–23:00, fri 08:00–23:00 (Asia/Kolkata)']),
    );
  });
});

describe('agent business hours: handoffs', () => {
  it('inside hours: offers immediately and starts the pickup SLA now', async () => {
    const id = await conversation(autoQueue);
    const outcome = await escalate(id, IN_HOURS);
    expect([EXEC_A, EXEC_B]).toContain(outcome.offeredTo);
    const conv = await convOf(id);
    expect(conv).toMatchObject({ controlState: 'WAITING_FOR_HUMAN', queueId: autoQueue, assignedUserId: outcome.offeredTo });
    expect(conv.slaDueAt).toEqual(plus(IN_HOURS, PICKUP_SLA));
    expect(await handoffOf(id)).toMatchObject({ status: 'OFFERED', autoAssignAt: null });
  });

  it('outside hours: routes to the queue, suppresses offers until the next opening and starts the SLA there', async () => {
    const id = await conversation(autoQueue);
    const outcome = await escalate(id, AFTER_CLOSE);
    expect(outcome).toMatchObject({ queueId: autoQueue, mode: 'AUTO_ASSIGN', offeredTo: null, alreadyOpen: false });
    const conv = await convOf(id);
    // Visible for pickup in its queue; nobody is offered it.
    expect(conv).toMatchObject({ controlState: 'WAITING_FOR_HUMAN', queueId: autoQueue, assignedUserId: null });
    expect(conv.waitingSince).toEqual(AFTER_CLOSE);
    expect(conv.slaDueAt).toEqual(plus(WED_OPEN, PICKUP_SLA));
    expect(await handoffOf(id)).toMatchObject({ status: 'WAITING', autoAssignAt: WED_OPEN, assignedUserId: null });
    const [route] = await t.db.select().from(auditEvents).where(and(eq(auditEvents.action, 'conversation.route_to_queue'), eq(auditEvents.targetId, id)));
    expect(route!.summary).toContain('outside human hours, team available Wednesday 23 Sep, 08:00 GMT+5:30');

    // Scheduler sweeps overnight make no offer…
    await autoAssignUnclaimed(t.db, plus(AFTER_CLOSE, 3600));
    await autoAssignUnclaimed(t.db, plus(WED_OPEN, -1));
    expect((await convOf(id)).assignedUserId).toBeNull();
    // …and the first sweep after opening does.
    await autoAssignUnclaimed(t.db, plus(WED_OPEN, 1));
    const offered = await handoffOf(id);
    expect(offered.status).toBe('OFFERED');
    expect([EXEC_A, EXEC_B]).toContain(offered.assignedUserId);
    expect(offered.offeredAt).toEqual(plus(WED_OPEN, 1));
  });

  it('open pickup: auto-assign-after counts from the next opening (weekend)', async () => {
    const id = await conversation(pickupQueue);
    await t.db.update(virtualAgents).set({ defaultQueueId: pickupQueue }).where(eq(virtualAgents.id, agentId));
    try {
      const outcome = await escalate(id, SATURDAY);
      expect(outcome).toMatchObject({ queueId: pickupQueue, mode: 'OPEN_PICKUP', offeredTo: null });
      expect((await convOf(id)).slaDueAt).toEqual(plus(MON_OPEN, PICKUP_SLA));
      expect((await handoffOf(id)).autoAssignAt).toEqual(plus(MON_OPEN, 120));
      await autoAssignUnclaimed(t.db, plus(MON_OPEN, 60));
      expect((await convOf(id)).assignedUserId).toBeNull();
      await autoAssignUnclaimed(t.db, plus(MON_OPEN, 121));
      expect((await handoffOf(id)).status).toBe('OFFERED');
    } finally {
      await t.db.update(virtualAgents).set({ defaultQueueId: autoQueue }).where(eq(virtualAgents.id, agentId));
    }
  });

  it('an offer that expires after closing is not re-offered until the next opening', async () => {
    const lastMinute = new Date('2026-09-22T17:29:00Z'); // 22:59 IST
    const id = await conversation(autoQueue);
    const first = (await escalate(id, lastMinute)).offeredTo!;
    expect(first).not.toBeNull();
    // The 60 s accept timeout runs out at 23:00 IST.
    expect(await expireOffers(t.db, plus(lastMinute, 90))).toBe(1);
    expect(await handoffOf(id)).toMatchObject({ status: 'WAITING', assignedUserId: null, autoAssignAt: WED_OPEN });
    expect((await convOf(id)).assignedUserId).toBeNull();
    await autoAssignUnclaimed(t.db, plus(WED_OPEN, 5));
    const reoffered = await handoffOf(id);
    expect(reoffered.status).toBe('OFFERED');
    expect(reoffered.assignedUserId).toBe(first === EXEC_A ? EXEC_B : EXEC_A);
  });

  it('switching to 24×7 releases AUTO_ASSIGN handoffs held for the next opening', async () => {
    const id = await conversation(autoQueue);
    await escalate(id, AFTER_CLOSE);
    expect((await handoffOf(id)).autoAssignAt).toEqual(WED_OPEN);
    await setHours({ timezone: 'Asia/Kolkata', humanHours: {} });
    try {
      expect((await handoffOf(id)).autoAssignAt).toBeNull();
      await autoAssignUnclaimed(t.db, plus(AFTER_CLOSE, 30));
      expect((await handoffOf(id)).status).toBe('OFFERED');
    } finally {
      await setHours(HOURS);
    }
  });

  it('empty hours mean humans 24×7: nothing changes at night', async () => {
    await setHours({ timezone: 'Asia/Kolkata', humanHours: {} });
    try {
      const id = await conversation(autoQueue);
      const outcome = await escalate(id, AFTER_CLOSE);
      expect(outcome.offeredTo).not.toBeNull();
      expect((await convOf(id)).slaDueAt).toEqual(plus(AFTER_CLOSE, PICKUP_SLA));
      expect((await handoffOf(id)).autoAssignAt).toBeNull();
    } finally {
      await setHours(HOURS);
    }
  });
});

async function convAgent() {
  return (await t.db.select().from(virtualAgents).where(eq(virtualAgents.id, agentId)))[0]!;
}
