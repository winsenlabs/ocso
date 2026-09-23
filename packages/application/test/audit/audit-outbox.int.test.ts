import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, inArray, isNull, sql } from 'drizzle-orm';
import { PostgresAuditStore } from '@ocso/audit-store';
import type { Principal } from '@ocso/auth';
import { agentTeams, auditEvents, auditIncidents, teamMembers, users, uuidv7, virtualAgents } from '@ocso/db';
import { createTestAuditDatabase, createTestDatabase, type TestAuditDatabase, type TestDatabase } from '@ocso/db/testing';
import { AuditShipper, DeploymentSettingsInput, RetentionService, SettingsService, auditTeams, reconcileAudit, recordAudit, systemActor, type ActorContext } from '../../src/index.js';
import { createTeam } from '../support/ownership.js';
import { FlakyStore, backdateAudit, failure } from './support.js';

let t: TestDatabase;
let a: TestAuditDatabase;
let store: FlakyStore;
const teamA = uuidv7();
const teamB = uuidv7();
const agentId = uuidv7();
const lead: Principal = { userId: uuidv7(), role: 'LEAD', displayName: 'Lina', teamIds: [teamB], via: 'UI' };
const as = (principal: Principal | null): ActorContext => ({ principal, correlationId: 'audit-test' });

beforeAll(async () => {
  t = await createTestDatabase();
  a = await createTestAuditDatabase();
  store = new FlakyStore(new PostgresAuditStore({ connectionString: a.url }));
  await createTeam(t.db, teamA);
  await createTeam(t.db, teamB);
  await t.db.insert(users).values({ id: lead.userId, email: 'lina@x.test', name: 'Lina', role: 'LEAD' });
  await t.db.insert(teamMembers).values({ teamId: teamB, userId: lead.userId });
  await t.db.insert(virtualAgents).values({ id: agentId, name: 'Maya', slug: `maya-${agentId}`, conversationType: 'SUPPORT' });
  await t.db.insert(agentTeams).values({ agentId, teamId: teamA });
});
afterAll(async () => {
  await store?.close();
  await t?.drop();
  await a?.drop();
});
beforeEach(() => {
  store.down = false;
  store.drop.clear();
});

const write = (action: string, targetType = 'x', targetId: string | null = null, actor: ActorContext = as(lead)) =>
  t.db.transaction((tx) => recordAudit(tx, actor, { action, targetType, targetId, summary: action }));

describe('recordAudit: team_ids (the store read scope)', () => {
  it("stores the target's teams ∪ the actor's teams", async () => {
    const id = await write('agent.update', 'agent', agentId);
    const [row] = await t.db.select().from(auditEvents).where(eq(auditEvents.id, id));
    expect(row!.teamIds).toEqual([teamA, teamB].sort());
  });

  it("resolves a user's teams, and an unknown or non-uuid target to the actor's teams only", async () => {
    expect(await auditTeams(t.db, 'user', lead.userId, as(null))).toEqual([teamB]);
    expect(await auditTeams(t.db, 'deployment', null, as(lead))).toEqual([teamB]);
    expect(await auditTeams(t.db, 'agent', 'not-a-uuid', systemActor('x', 'c'))).toEqual([]);
  });

  it("gives an agent actor's events the agent's teams", async () => {
    expect(await auditTeams(t.db, 'conversation', uuidv7(), { principal: null, system: { kind: 'AGENT', id: agentId }, correlationId: 'c' })).toEqual([teamA]);
  });
});

describe('audit_events trigger (migration 0026)', () => {
  it('lets only shipped_at / verified_at change', async () => {
    const id = await write('trigger.update');
    // Never verified without having been shipped (a forged verified_at would let the prune delete an unshipped row).
    expect(await failure(t.db.update(auditEvents).set({ verifiedAt: new Date() }).where(eq(auditEvents.id, id)))).toMatch(/append-only/);
    expect(await failure(t.db.update(auditEvents).set({ shippedAt: new Date(), verifiedAt: new Date() }).where(eq(auditEvents.id, id)))).toMatch(/append-only/);
    await t.db.update(auditEvents).set({ shippedAt: new Date() }).where(eq(auditEvents.id, id));
    await t.db.update(auditEvents).set({ verifiedAt: new Date() }).where(eq(auditEvents.id, id));
    expect(await failure(t.db.update(auditEvents).set({ shippedAt: null }).where(eq(auditEvents.id, id)))).toMatch(/append-only/);
    await t.db.update(auditEvents).set({ shippedAt: null, verifiedAt: null }).where(eq(auditEvents.id, id));
    expect(await failure(t.db.execute(sql`UPDATE audit_events SET summary = 'rewritten' WHERE id = ${id}`))).toMatch(/append-only/);
    expect(await failure(t.db.execute(sql`UPDATE audit_events SET team_ids = '{}' WHERE id = ${id}`))).toMatch(/append-only/);
    expect(await failure(t.db.execute(sql`UPDATE audit_events SET summary = 'x', shipped_at = now() WHERE id = ${id}`))).toMatch(/append-only/);
    expect(await failure(t.db.execute(sql`TRUNCATE audit_events`))).toMatch(/append-only/);
  });

  it('prunes only verified rows older than 90 days, and only when the transaction asks', async () => {
    const [verifiedOld, unverifiedOld, verifiedYoung] = [await write('prune.a'), await write('prune.b'), await write('prune.c')];
    await backdateAudit(t.db, [verifiedOld, unverifiedOld], 100);
    await t.db.update(auditEvents).set({ shippedAt: new Date() }).where(inArray(auditEvents.id, [verifiedOld, verifiedYoung]));
    await t.db.update(auditEvents).set({ verifiedAt: new Date() }).where(inArray(auditEvents.id, [verifiedOld, verifiedYoung]));
    const prune = (id: string) =>
      t.db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('ocso.audit_local_prune', 'on', true)`);
        await tx.execute(sql`DELETE FROM audit_events WHERE id = ${id}`);
      });
    expect(await failure(t.db.execute(sql`DELETE FROM audit_events WHERE id = ${verifiedOld}`))).toMatch(/append-only/);
    expect(await failure(prune(unverifiedOld))).toMatch(/append-only/);
    expect(await failure(prune(verifiedYoung))).toMatch(/append-only/);
    await prune(verifiedOld);
    const left = await t.db.select({ id: auditEvents.id }).from(auditEvents).where(inArray(auditEvents.id, [verifiedOld, unverifiedOld, verifiedYoung]));
    expect(left.map((r) => r.id).sort()).toEqual([unverifiedOld, verifiedYoung].sort());
  });
});

describe('audit-ship and audit-reconcile', () => {
  it('ships the outbox to the store once, idempotently', async () => {
    const id = await write('ship.one');
    const shipper = new AuditShipper(t.db, store, { batch: 3 });
    const result = await shipper.ship();
    expect(result.shipped).toBeGreaterThan(0);
    expect((await store.has([id])).has(id)).toBe(true);
    expect(await t.db.$count(auditEvents, isNull(auditEvents.shippedAt))).toBe(0);
    expect((await shipper.ship()).shipped).toBe(0);
  });

  it('keeps serving through a store outage: incident, backoff, then catches up and resolves it', async () => {
    let clock = Date.now();
    const shipper = new AuditShipper(t.db, store, { now: () => clock });
    store.down = true;
    const id = await write('ship.during-outage');
    const failed = await shipper.ship();
    expect(failed.error).toMatch(/ECONNREFUSED/);
    const [incident] = await t.db.select().from(auditIncidents).where(isNull(auditIncidents.resolvedAt));
    expect(incident).toMatchObject({ kind: 'STORE_DOWN', count: 1 });
    expect(incident!.detail).toMatchObject({ unshipped: 1, attempts: 1 });
    // Backing off: the next tick does not even try.
    expect(await shipper.ship()).toEqual({ shipped: 0, deferred: true });
    clock += 3_000;
    await shipper.ship();
    expect((await t.db.select().from(auditIncidents).where(isNull(auditIncidents.resolvedAt)))[0]!.count).toBe(2);
    // The row is still in the outbox, readable, never lost.
    expect((await t.db.select().from(auditEvents).where(eq(auditEvents.id, id)))[0]!.shippedAt).toBeNull();
    store.down = false;
    clock += 60_000;
    expect((await shipper.ship()).shipped).toBe(1);
    expect(await t.db.$count(auditIncidents, isNull(auditIncidents.resolvedAt))).toBe(0);
  });

  it('reconciliation verifies held rows and re-ships rows the store lost', async () => {
    const kept = await write('reconcile.kept');
    const lost = await write('reconcile.lost');
    store.drop.add(lost);
    await new AuditShipper(t.db, store).ship();
    const result = await reconcileAudit(t.db, store, { graceSeconds: -1 });
    expect(result.missing).toBe(1);
    const rows = await t.db.select().from(auditEvents).where(inArray(auditEvents.id, [kept, lost]));
    expect(rows.find((r) => r.id === kept)!.verifiedAt).not.toBeNull();
    expect(rows.find((r) => r.id === lost)).toMatchObject({ shippedAt: null, verifiedAt: null });
    const [incident] = await t.db.select().from(auditIncidents).where(eq(auditIncidents.kind, 'RECONCILE_MISSING'));
    expect(incident).toMatchObject({ resolvedAt: null, detail: expect.objectContaining({ missing: 1, sample: [lost] }) });
    store.drop.clear();
    await new AuditShipper(t.db, store).ship();
    expect(await reconcileAudit(t.db, store, { graceSeconds: -1 })).toMatchObject({ missing: 0 });
    expect((await t.db.select().from(auditIncidents).where(eq(auditIncidents.kind, 'RECONCILE_MISSING')))[0]!.resolvedAt).not.toBeNull();
    expect((await t.db.select().from(auditEvents).where(eq(auditEvents.id, lost)))[0]!.verifiedAt).not.toBeNull();
  });

  it('does not verify rows younger than the grace period', async () => {
    await write('reconcile.young');
    await new AuditShipper(t.db, store).ship();
    expect((await reconcileAudit(t.db, store, { graceSeconds: 3600 })).checked).toBe(0);
  });
});

describe('the local audit window setting', () => {
  it('is a deployment setting with a 90-day floor (the widest analytics window)', async () => {
    const tech: Principal = { userId: uuidv7(), role: 'TECH', displayName: 'Tia', teamIds: [], via: 'UI' };
    await t.db.insert(users).values({ id: tech.userId, email: 'tia@x.test', name: 'Tia', role: 'TECH' });
    expect(DeploymentSettingsInput.safeParse({ auditLocalWindowDays: 89 }).success).toBe(false);
    const after = await new SettingsService(t.db).updateDeployment(as(tech), { auditLocalWindowDays: 120 });
    expect(after.auditLocalWindowDays).toBe(120);
    await new SettingsService(t.db).updateDeployment(as(tech), { auditLocalWindowDays: 90 });
  });
});

describe('retention with an audit store', () => {
  it('prunes verified rows beyond the local window, keeps everything unverified, and asks the store to purge', async () => {
    const shippedOld = await write('retention.verified-old');
    const pendingOld = await write('retention.unshipped-old');
    await new AuditShipper(t.db, store).ship();
    await backdateAudit(t.db, [shippedOld, pendingOld], 120);
    await t.db.update(auditEvents).set({ shippedAt: null }).where(eq(auditEvents.id, pendingOld));
    await reconcileAudit(t.db, store, { graceSeconds: -1 });
    // pendingOld was re-shipped by nobody yet: unverified, so it must stay.
    await t.db.update(auditEvents).set({ shippedAt: null, verifiedAt: null }).where(eq(auditEvents.id, pendingOld));
    let purgedBefore: Date | null = null;
    const spy = Object.assign(Object.create(store) as FlakyStore, { purgeBefore: async (cutoff: Date) => ((purgedBefore = cutoff), 0) });
    await new RetentionService(t.db, { delete: async () => {} }, () => {}, spy).run();
    const left = await t.db.select({ id: auditEvents.id }).from(auditEvents).where(inArray(auditEvents.id, [shippedOld, pendingOld]));
    expect(left.map((r) => r.id)).toEqual([pendingOld]);
    expect(purgedBefore!.getTime()).toBeLessThan(Date.now() - 2554 * 24 * 3600 * 1000);
    const [applied] = await t.db.select().from(auditEvents).where(eq(auditEvents.action, 'retention.applied'));
    // shippedOld, and the 100-day 'prune.b' row of the trigger test, which this test's reconcile verified.
    expect(applied!.after).toMatchObject({ auditLocalPruned: 2, auditLocalWindowDays: 90 });
    expect(await t.db.$count(auditEvents, eq(auditEvents.action, 'prune.b'))).toBe(0);
  });
});
