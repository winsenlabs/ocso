import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from '@ocso/db/testing';
import { alertDeliveries, alertRules, alerts, loginAttempts, notificationDestinations, uuidv7 } from '@ocso/db';
import type { Principal } from '@ocso/auth';
import { MemoryQueue } from '@ocso/queue';
import { AlertEngine, AlertService, type ActorContext, type AlertRuleRow } from '../src/index.js';

let t: TestDatabase;
let queue: MemoryQueue;
let engine: AlertEngine;
const T0 = new Date();
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);
const ctx = (principal: Principal | null): ActorContext => ({ principal, correlationId: 'test' });
const principal = (role: Principal['role']): Principal => ({ userId: uuidv7(), role, displayName: role, teamIds: [], via: 'UI' });
const admin = principal('PLATFORM_TECH_ADMIN');
const lead = principal('CS_LEAD');
const exec = principal('CS_EXEC');
const dest: Record<'inApp' | 'webhook' | 'slack', string> = { inApp: uuidv7(), webhook: uuidv7(), slack: uuidv7() };

beforeAll(async () => {
  t = await createTestDatabase();
  queue = new MemoryQueue();
  engine = new AlertEngine({ db: t.db, queue });
  await t.db.insert(notificationDestinations).values([
    { id: dest.inApp, name: 'In-app', kind: 'IN_APP' },
    { id: dest.webhook, name: 'Ops webhook', kind: 'WEBHOOK', config: { url: 'https://hooks.example.com/x' }, secretRef: 'sec_x' },
    { id: dest.slack, name: 'Slack #alerts', kind: 'SLACK', secretRef: 'sec_y' },
  ]);
});
afterAll(async () => {
  await t?.drop();
});

async function authRule(extra: Partial<AlertRuleRow> = {}): Promise<AlertRuleRow> {
  const [row] = await t.db
    .insert(alertRules)
    .values({
      id: uuidv7(),
      name: 'Sign-in failures',
      kind: 'TECHNICAL',
      condition: 'auth_failures_above',
      params: { threshold: 0 },
      windowSeconds: 300,
      dedupeWindowSeconds: 1800,
      audienceRoles: ['PLATFORM_TECH_ADMIN'],
      destinationIds: [dest.inApp, dest.webhook, dest.slack],
      ...extra,
    })
    .returning();
  return row!;
}

const failAt = (when: Date) => t.db.insert(loginAttempts).values({ id: uuidv7(), email: 'x@y.test', success: false, occurredAt: when });
const rowsFor = (ruleId: string) => t.db.select().from(alerts).where(eq(alerts.ruleId, ruleId)).orderBy(alerts.openedAt);
const deliveriesFor = (alertId: string) => t.db.select().from(alertDeliveries).where(eq(alertDeliveries.alertId, alertId));
const outboxCount = async (type: string, alertId: string) => {
  const r = await t.db.execute(sql`SELECT count(*)::int AS n FROM outbox_events WHERE type = ${type} AND payload->>'alertId' = ${alertId}`);
  return (r.rows[0] as { n: number }).n;
};

describe('alert engine lifecycle', () => {
  it('opens, dedupes, auto-resolves and respects the dedupe window', async () => {
    await t.db.execute(sql`DELETE FROM login_attempts`);
    const r = await authRule();
    await failAt(at(-60));

    // 1. Open: alert row, one delivery per destination receiving OPENED, one job each, alert.opened.
    const first = await engine.evaluate(T0, { ruleIds: [r.id] });
    expect(first).toMatchObject({ rules: 1, opened: 1, deliveriesQueued: 3, failed: [] });
    let [alert] = await rowsFor(r.id);
    expect(alert).toMatchObject({ status: 'OPEN', occurrences: 1, kind: 'TECHNICAL', severity: 'WARNING', audienceRoles: ['PLATFORM_TECH_ADMIN'] });
    const opened = await deliveriesFor(alert!.id);
    expect(opened.map((d) => d.destinationId).sort()).toEqual([dest.inApp, dest.webhook, dest.slack].sort());
    expect(opened.every((d) => d.event === 'OPENED' && d.status === 'PENDING')).toBe(true);
    expect(queue.pending('alert.deliver')).toBe(3);
    expect(await outboxCount('alert.opened', alert!.id)).toBe(1);

    // 2. Dedupe: still firing → same alert bumped, no new deliveries or events.
    const second = await engine.evaluate(at(10), { ruleIds: [r.id] });
    expect(second).toMatchObject({ opened: 0, updated: 1, deliveriesQueued: 0 });
    [alert] = await rowsFor(r.id);
    expect(alert).toMatchObject({ status: 'OPEN', occurrences: 2 });
    expect(alert!.lastSeenAt.getTime()).toBe(at(10).getTime());
    expect(await deliveriesFor(alert!.id)).toHaveLength(3);
    expect(await outboxCount('alert.opened', alert!.id)).toBe(1);

    // 3. Auto-resolve once the window no longer contains failures; RESOLVED goes to webhook + Slack, not in-app.
    const third = await engine.evaluate(at(600), { ruleIds: [r.id] });
    expect(third).toMatchObject({ resolved: 1, deliveriesQueued: 2 });
    [alert] = await rowsFor(r.id);
    expect(alert).toMatchObject({ status: 'RESOLVED', resolution: 'Auto-resolved: condition no longer met', resolvedBy: null });
    const resolvedDeliveries = (await deliveriesFor(alert!.id)).filter((d) => d.event === 'RESOLVED');
    expect(resolvedDeliveries.map((d) => d.destinationId).sort()).toEqual([dest.webhook, dest.slack].sort());
    expect(await outboxCount('alert.resolved', alert!.id)).toBe(1);
    const audit = await t.pool.query(`SELECT action, actor_type FROM audit_events WHERE target_id = $1`, [alert!.id]);
    expect(audit.rows).toEqual([{ action: 'alert.auto_resolve', actor_type: 'SYSTEM' }]);

    // 4. Fires again within the dedupe window → suppressed, no reopen.
    await failAt(at(700));
    const fourth = await engine.evaluate(at(800), { ruleIds: [r.id] });
    expect(fourth).toMatchObject({ opened: 0, suppressed: 1 });
    expect(await rowsFor(r.id)).toHaveLength(1);

    // 5. After the dedupe window → a new alert with the same fingerprint.
    await failAt(at(2500));
    const fifth = await engine.evaluate(at(2600), { ruleIds: [r.id] });
    expect(fifth.opened).toBe(1);
    const rows = await rowsFor(r.id);
    expect(rows).toHaveLength(2);
    expect(rows[1]!.fingerprint).toBe(rows[0]!.fingerprint);
    expect(rows[1]!.status).toBe('OPEN');
  });

  it('keeps alerts open when autoResolve is off, and skips disabled rules', async () => {
    await t.db.execute(sql`DELETE FROM login_attempts`);
    const sticky = await authRule({ autoResolve: false, destinationIds: [] });
    const disabled = await authRule({ enabled: false });
    await failAt(at(-30));
    const summary = await engine.evaluate(T0, { ruleIds: [sticky.id, disabled.id] });
    expect(summary).toMatchObject({ rules: 1, opened: 1, deliveriesQueued: 0 });
    await engine.evaluate(at(3600), { ruleIds: [sticky.id] });
    expect((await rowsFor(sticky.id))[0]!.status).toBe('OPEN');
    expect(await rowsFor(disabled.id)).toHaveLength(0);
  });

  it('isolates a failing rule from the others', async () => {
    const broken = await authRule({ condition: 'no_such_condition' });
    const ok = await authRule({ destinationIds: [] });
    await failAt(at(-5));
    const summary = await engine.evaluate(T0, { ruleIds: [broken.id, ok.id] });
    expect(summary.failed).toEqual([{ ruleId: broken.id, condition: 'no_such_condition', error: 'unknown condition no_such_condition' }]);
    expect(await rowsFor(ok.id)).toHaveLength(1);
  });
});

describe('alert inbox: audience scoping, acknowledge, resolve', () => {
  const ids = { technical: uuidv7(), business: uuidv7(), leadOnly: uuidv7(), sharedBusiness: uuidv7() };
  const agentId = uuidv7();
  let businessRule: string;

  beforeAll(async () => {
    const [r] = await t.db
      .insert(alertRules)
      .values({ id: uuidv7(), name: 'SLA', kind: 'BUSINESS', condition: 'sla_breaches_above', audienceRoles: ['CS_LEAD', 'CS_EXEC'], destinationIds: [dest.webhook, dest.slack] })
      .returning();
    businessRule = r!.id;
    const base = { title: 'x', body: 'b', source: 's', severity: 'WARNING' as const, openedAt: T0, lastSeenAt: T0 };
    await t.db.insert(alerts).values([
      { ...base, id: ids.technical, fingerprint: `f-${ids.technical}`, kind: 'TECHNICAL', audienceRoles: ['PLATFORM_TECH_ADMIN'], title: 'Provider down', severity: 'CRITICAL' },
      { ...base, id: ids.business, ruleId: businessRule, fingerprint: `f-${ids.business}`, kind: 'BUSINESS', audienceRoles: ['CS_LEAD', 'CS_EXEC'], title: 'SLA breaches · Maya', context: { agentId } },
      { ...base, id: ids.leadOnly, fingerprint: `f-${ids.leadOnly}`, kind: 'BUSINESS', audienceRoles: ['CS_LEAD'], title: 'Escalation rate' },
      // Audience includes the Tech Admin, but Tech Admin cannot read BUSINESS alerts.
      { ...base, id: ids.sharedBusiness, fingerprint: `f-${ids.sharedBusiness}`, kind: 'BUSINESS', audienceRoles: ['CS_LEAD', 'PLATFORM_TECH_ADMIN'], title: 'Tool failing', severity: 'CRITICAL' },
    ]);
  });

  const listIds = async (p: Principal, query = {}) => (await new AlertService(t.db, queue).list(ctx(p), query)).items.map((a) => a.id).filter((id) => Object.values(ids).includes(id)).sort();

  it('shows an alert only when the role is in its audience AND the kind is readable', async () => {
    expect(await listIds(exec)).toEqual([ids.business]);
    expect(await listIds(lead)).toEqual([ids.business, ids.leadOnly, ids.sharedBusiness].sort());
    expect(await listIds(admin)).toEqual([ids.technical]);
    expect(await listIds(lead, { agentId })).toEqual([ids.business]);
    expect(await listIds(lead, { severity: 'CRITICAL' })).toEqual([ids.sharedBusiness]);
    const svc = new AlertService(t.db, queue);
    await expect(svc.list(ctx(exec), { kind: 'TECHNICAL' })).rejects.toMatchObject({ category: 'authorization' });
    await expect(svc.get(ctx(exec), ids.technical)).rejects.toMatchObject({ category: 'not_found' });
    await expect(svc.get(ctx(admin), ids.sharedBusiness)).rejects.toMatchObject({ category: 'not_found' });
    expect((await svc.get(ctx(exec), ids.business)).agentId).toBe(agentId);
  });

  it('paginates with a keyset cursor', async () => {
    const svc = new AlertService(t.db, queue);
    const page1 = await svc.list(ctx(lead), { limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await svc.list(ctx(lead), { limit: 2, cursor: page1.nextCursor! });
    expect(page2.items.map((i) => i.id)).not.toContain(page1.items[0]!.id);
    await expect(svc.list(ctx(lead), { cursor: 'garbage' })).rejects.toMatchObject({ code: 'invalid_cursor' });
  });

  it('counts unresolved visible alerts for nav badges', async () => {
    const svc = new AlertService(t.db, queue);
    const execCounts = await svc.counts(ctx(exec));
    expect(execCounts.byKind).toEqual({ BUSINESS: execCounts.unresolved });
    expect(execCounts.byKind['TECHNICAL']).toBeUndefined();
    const leadCounts = await svc.counts(ctx(lead), { agentId });
    expect(leadCounts).toMatchObject({ unresolved: 1, open: 1, bySeverity: { WARNING: 1, CRITICAL: 0, INFO: 0 } });
  });

  it('acknowledges and resolves with audit, events and lifecycle deliveries', async () => {
    const svc = new AlertService(t.db, queue);
    await expect(svc.acknowledge(ctx(admin), ids.business)).rejects.toMatchObject({ category: 'not_found' });

    const acked = await svc.acknowledge(ctx(exec), ids.business, { note: 'looking into it' });
    expect(acked).toMatchObject({ status: 'ACKNOWLEDGED', acknowledgedBy: exec.userId });
    // ACKNOWLEDGED goes to the webhook only (Slack announces open/resolve).
    let deliveries = await deliveriesFor(ids.business);
    expect(deliveries.map((d) => [d.event, d.destinationId])).toEqual([['ACKNOWLEDGED', dest.webhook]]);
    await svc.acknowledge(ctx(lead), ids.business); // idempotent
    expect(await deliveriesFor(ids.business)).toHaveLength(1);

    await expect(svc.resolve(ctx(exec), ids.business, { note: '  ' })).rejects.toMatchObject({ code: 'resolution_note_required' });
    const resolved = await svc.resolve(ctx(exec), ids.business, { note: 'Picked up all breached chats' });
    expect(resolved).toMatchObject({ status: 'RESOLVED', resolvedBy: exec.userId, resolution: 'Picked up all breached chats' });
    deliveries = await deliveriesFor(ids.business);
    expect(deliveries.filter((d) => d.event === 'RESOLVED').map((d) => d.destinationId).sort()).toEqual([dest.webhook, dest.slack].sort());
    await expect(svc.resolve(ctx(exec), ids.business, { note: 'again' })).rejects.toMatchObject({ code: 'alert_resolved' });
    await expect(svc.acknowledge(ctx(exec), ids.business)).rejects.toMatchObject({ code: 'alert_resolved' });

    const audit = await t.pool.query(`SELECT action, actor_id, after FROM audit_events WHERE target_id = $1 ORDER BY occurred_at`, [ids.business]);
    expect(audit.rows.map((r) => r.action)).toEqual(['alert.acknowledge', 'alert.resolve']);
    expect(audit.rows[0].actor_id).toBe(exec.userId);
    expect(audit.rows[0].after).toMatchObject({ status: 'ACKNOWLEDGED', note: 'looking into it' });
    expect(await outboxCount('alert.updated', ids.business)).toBe(2);
    expect(await outboxCount('alert.resolved', ids.business)).toBe(1);
    const [{ agent_id }] = (await t.db.execute(sql`SELECT agent_id FROM outbox_events WHERE type = 'alert.resolved' AND payload->>'alertId' = ${ids.business}`)).rows as [{ agent_id: string }];
    expect(agent_id).toBe(agentId);
    const [row] = await t.db.select().from(alerts).where(and(eq(alerts.id, ids.business)));
    expect(row!.status).toBe('RESOLVED');
  });
});
