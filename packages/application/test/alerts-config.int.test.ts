import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from '@ocso/db/testing';
import { alertDeliveries, alertRules, alerts, notificationDestinations, uuidv7, virtualAgents } from '@ocso/db';
import { createDefaultDeliveryRegistry, verifySignature, type FetchFn } from '@ocso/alerts';
import type { Principal } from '@ocso/auth';
import { MemoryQueue } from '@ocso/queue';
import { createTeam, ownAgents } from './support/ownership.js';
import { InMemorySecretRows, LocalSecretStore, parseMasterKey } from '@ocso/secrets';
import {
  AlertDeliveryService,
  AlertRuleService,
  NotificationDestinationService,
  isAlertDeliveryRetryable,
  seedDefaultAlertRules,
  type ActorContext,
  type AlertRuleInput,
  sweepApprovalSecrets,
} from '../src/index.js';
import { platformApprover, type PlatformApprover } from './support/platform-approvals.js';

let t: TestDatabase;
const queue = new MemoryQueue();
const rows = new InMemorySecretRows();
const secrets = new LocalSecretStore(rows, parseMasterKey('k1', randomBytes(32).toString('base64')));
const WEBHOOK_SECRET = 'whsec_super_secret_value_123';

/** Scripted HTTP responses; records every request. */
let responses: number[] = [];
const requests: Array<{ url: string; headers: Headers; body: string }> = [];
const fetchFake: FetchFn = async (input, init) => {
  requests.push({ url: String(input), headers: new Headers(init?.headers), body: String(init?.body ?? '') });
  const status = responses.shift() ?? 200;
  return new Response(status === 204 ? null : '', { status });
};
const registry = createDefaultDeliveryRegistry({ fetch: fetchFake });

const ctx = (principal: Principal | null): ActorContext => ({ principal, correlationId: 'test' });
// The lead's team owns Maya, so the lead may target her in agent-scoped rules (ADR-026).
const TEAM = uuidv7();
const principal = (role: Principal['role']): Principal => ({ userId: uuidv7(), role, displayName: role, teamIds: role === 'HEAD' ? [TEAM] : [], via: 'UI' });
const admin = principal('TECH');
const lead = principal('HEAD');
const exec = principal('SERVICE');
let agentId: string;
let approver: PlatformApprover;

beforeAll(async () => {
  t = await createTestDatabase();
  for (const p of [admin, lead, exec]) {
    await t.pool.query(`INSERT INTO users (id, email, name, role) VALUES ($1, $2, $3, $4)`, [p.userId, `${p.userId}@x.test`, p.role, p.role]);
  }
  agentId = uuidv7();
  await t.db.insert(virtualAgents).values({ id: agentId, name: 'Maya', slug: 'maya', conversationType: 'SUPPORT' });
  await ownAgents(t.db, await createTeam(t.db, TEAM), agentId);
  approver = await platformApprover(t.db, { secrets, deliveries: registry });
});
afterAll(async () => {
  await t?.drop();
});

const rules = () => new AlertRuleService(t.db, queue, registry);
const destinations = () => new NotificationDestinationService(t.db, secrets, registry, { baseUrl: 'https://ocso.test' });
const input = (o: Partial<AlertRuleInput>): AlertRuleInput => ({
  name: 'rule',
  kind: 'BUSINESS',
  condition: 'escalation_rate_above',
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

describe('alert rules', () => {
  it('requires the manage permission for the rule kind', async () => {
    await expect(rules().create(ctx(lead), input({ kind: 'TECHNICAL', condition: 'workers_below_min', audienceRoles: ['TECH'] }))).rejects.toMatchObject({
      category: 'authorization',
    });
    await expect(rules().create(ctx(admin), input({}))).rejects.toMatchObject({ category: 'authorization' });
    await expect(rules().create(ctx(exec), input({}))).rejects.toMatchObject({ category: 'authorization' });
    const created = await rules().create(ctx(lead), input({ name: 'Maya escalations', agentId, params: { thresholdPercent: 18 } }));
    expect(created).toMatchObject({ kind: 'BUSINESS', agentId, createdBy: lead.userId, conditionLabel: 'Escalation rate above threshold' });
    // Params are normalized with the evaluator's defaults.
    expect(created.params).toEqual({ thresholdPercent: 18, minConversations: 20 });
  });

  it('validates condition/kind, params, agent scope, audience and destinations', async () => {
    const svc = rules();
    const cases: Array<[Partial<AlertRuleInput>, string]> = [
      [{ condition: 'nope' }, 'unknown_condition'],
      [{ condition: 'workers_below_min' }, 'condition_kind_mismatch'],
      [{ params: { thresholdPercent: 500 } }, 'invalid_alert_params'],
      [{ params: { unknownKey: 1 } }, 'invalid_alert_params'],
      [{ agentId: uuidv7() }, 'unknown_agent'],
      [{ destinationIds: [uuidv7()] }, 'unknown_destination'],
      [{ audienceRoles: ['HEAD', 'TECH'] }, 'audience_cannot_read_kind'],
    ];
    for (const [patch, code] of cases) await expect(svc.create(ctx(lead), input(patch)), code).rejects.toMatchObject({ code });
    await expect(
      svc.create(ctx(admin), input({ kind: 'TECHNICAL', condition: 'workers_below_min', agentId, audienceRoles: ['TECH'] })),
    ).rejects.toMatchObject({ code: 'condition_not_agent_scoped' });
    await expect(svc.create(ctx(admin), input({ kind: 'TECHNICAL', condition: 'workers_below_min', audienceRoles: ['SERVICE'] }))).rejects.toMatchObject({
      code: 'audience_cannot_read_kind',
    });
    // tool_failure_rate_above may be either kind.
    expect((await svc.create(ctx(admin), input({ kind: 'TECHNICAL', condition: 'tool_failure_rate_above', audienceRoles: ['TECH'] }))).kind).toBe('TECHNICAL');
  });

  it('lists and describes only what the role may see; exposes each method', async () => {
    const execConditions = rules().conditions(ctx(exec));
    expect(execConditions.every((c) => c.kinds.includes('BUSINESS'))).toBe(true);
    expect(execConditions.map((c) => c.condition)).toContain('csat_below');
    expect(execConditions.find((c) => c.condition === 'csat_below')!.params).toMatchObject({ type: 'object' });
    const adminConditions = rules().conditions(ctx(admin)).map((c) => c.condition);
    expect(adminConditions).toContain('workers_below_min');
    expect(adminConditions).not.toContain('csat_below');
    expect((await rules().list(ctx(exec))).every((r) => r.kind === 'BUSINESS')).toBe(true);
    await expect(rules().list(ctx(exec), { kind: 'TECHNICAL' })).rejects.toMatchObject({ category: 'authorization' });
    expect((await rules().list(ctx(admin))).every((r) => r.kind === 'TECHNICAL')).toBe(true);
  });

  it('updates a draft with re-validation (deleting is an approved proposal: approvals/business-alert-rules.int.test.ts)', async () => {
    const svc = rules();
    const rule = await svc.create(ctx(lead), input({ name: 'CSAT floor', condition: 'csat_below' }));
    await expect(svc.update(ctx(admin), rule.id, { enabled: false })).rejects.toMatchObject({ category: 'authorization' });
    await expect(svc.update(ctx(lead), rule.id, { kind: 'TECHNICAL' })).rejects.toMatchObject({ category: 'authorization' });
    const updated = await svc.update(ctx(lead), rule.id, { params: { threshold: 3.5 }, severity: 'CRITICAL' });
    expect(updated).toMatchObject({ severity: 'CRITICAL', params: { threshold: 3.5, minResponses: 20 } });
    // Switching condition resets params to the new condition's defaults.
    expect((await svc.update(ctx(lead), rule.id, { condition: 'sla_breaches_above' })).params).toEqual({ threshold: 0 });
    // A new rule is a disabled draft, whatever the input said.
    expect(rule.enabled).toBe(false);
    expect(await svc.objectKindOf(ctx(lead), rule.id)).toBe('alert_rule');
    const audit = await t.pool.query(`SELECT action FROM audit_events WHERE target_id = $1 ORDER BY occurred_at`, [rule.id]);
    expect(audit.rows.map((r) => r.action)).toEqual(['alert_rule.create', 'alert_rule.update', 'alert_rule.update']);
  });
});

describe('notification destinations', () => {
  it('stores secrets only in the SecretStore and never returns or audits them', async () => {
    await expect(destinations().create(ctx(lead), { name: 'x', kind: 'IN_APP', config: {}, enabled: true })).rejects.toMatchObject({ category: 'authorization' });
    await expect(destinations().create(ctx(admin), { name: 'Slack', kind: 'SLACK', config: {}, enabled: true })).rejects.toMatchObject({ code: 'secret_required' });
    await expect(destinations().create(ctx(admin), { name: 'Slack', kind: 'SLACK', config: {}, secret: 'http://insecure', enabled: true })).rejects.toMatchObject({
      code: 'invalid_destination_secret',
    });
    await expect(destinations().create(ctx(admin), { name: 'Hook', kind: 'WEBHOOK', config: { url: 'http://x' }, secret: WEBHOOK_SECRET, enabled: true })).rejects.toMatchObject({
      code: 'invalid_destination_config',
    });
    const hook = await destinations().create(ctx(admin), { name: 'Ops webhook', kind: 'WEBHOOK', config: { url: 'https://ops.example.com/hook' }, secret: WEBHOOK_SECRET, enabled: true });
    expect(hook).toMatchObject({ kind: 'WEBHOOK', hasSecret: true, config: { url: 'https://ops.example.com/hook' } });
    expect(JSON.stringify(hook)).not.toContain(WEBHOOK_SECRET);
    const [row] = await t.db.select().from(notificationDestinations).where(eq(notificationDestinations.id, hook.id));
    expect(row!.secretRef).toMatch(/^sec_/);
    expect(JSON.stringify(rows.raw(row!.secretRef!))).not.toContain(WEBHOOK_SECRET);
    expect(await secrets.resolve(row!.secretRef!)).toBe(WEBHOOK_SECRET);

    // A draft's secret is replaced directly (a new secret; the old one is deleted).
    await destinations().update(ctx(admin), hook.id, { secret: 'whsec_rotated_value_4567' });
    const [replaced] = await t.db.select().from(notificationDestinations).where(eq(notificationDestinations.id, hook.id));
    expect(await secrets.resolve(replaced!.secretRef!)).toBe('whsec_rotated_value_4567');
    expect(await secrets.describe(row!.secretRef!)).toBeNull();
    const audit = await t.pool.query(`SELECT before::text, after::text FROM audit_events WHERE target_type = 'notification_destination'`);
    expect(JSON.stringify(audit.rows)).not.toContain('whsec_');

    // Rule editors see destinations to attach them, without configuration.
    const leadView = await destinations().list(ctx(lead));
    expect(leadView.find((d) => d.id === hook.id)).toMatchObject({ config: null, hasSecret: true });
    await expect(destinations().list(ctx(exec))).rejects.toMatchObject({ category: 'authorization' });
  });

  it('test-sends a signed synthetic alert and deletes cleanly', async () => {
    const hook = await destinations().create(ctx(admin), { name: 'Test hook', kind: 'WEBHOOK', config: { url: 'https://ops.example.com/test' }, secret: WEBHOOK_SECRET, enabled: true });
    requests.length = 0;
    responses = [204];
    expect(await destinations().test(ctx(admin), hook.id)).toEqual({ ok: true, retriable: false });
    const req = requests[0]!;
    expect(verifySignature(req.headers.get('x-ocso-signature'), req.body, WEBHOOK_SECRET, { nowSeconds: Math.floor(Date.now() / 1000) })).toBe(true);
    expect(JSON.parse(req.body)).toMatchObject({ type: 'alert.opened', alert: { title: 'Test alert from OCSO', link: 'https://ocso.test' } });
    responses = [500];
    expect(await destinations().test(ctx(admin), hook.id)).toEqual({ ok: false, retriable: true, error: 'HTTP 500' });

    const rule = await rules().create(ctx(lead), input({ name: 'With hook', destinationIds: [hook.id] }));
    const [row] = await t.db.select().from(notificationDestinations).where(eq(notificationDestinations.id, hook.id));
    await expect(destinations().delete(ctx(admin), hook.id)).rejects.toMatchObject({ code: 'approval_required' });
    await approver.approve(ctx(admin), 'notification_destination', hook.id, 'DELETE');
    expect((await rules().get(ctx(lead), rule.id)).destinationIds).toEqual([]);
    // Released in the approval's transaction; the leader sweep deletes it after that commits.
    await sweepApprovalSecrets(t.db, secrets);
    expect(await secrets.describe(row!.secretRef!)).toBeNull();
  });
});

describe('alert delivery service', () => {
  let alertId: string;
  let hookId: string;
  const svc = (maxAttempts = 3) => new AlertDeliveryService({ db: t.db, secrets, registry, baseUrl: 'https://ocso.test', maxAttempts });
  const delivery = async (destinationId: string) => {
    const id = uuidv7();
    await t.db.insert(alertDeliveries).values({ id, alertId, destinationId, event: 'OPENED' });
    return id;
  };
  const load = async (id: string) => (await t.db.select().from(alertDeliveries).where(eq(alertDeliveries.id, id)))[0]!;

  beforeAll(async () => {
    alertId = uuidv7();
    await t.db.insert(alerts).values({ id: alertId, fingerprint: `f-${alertId}`, kind: 'TECHNICAL', severity: 'CRITICAL', title: 'Provider down', body: 'b', audienceRoles: ['TECH'], source: 'Provider · X' });
    hookId = (await destinations().create(ctx(admin), { name: 'Delivery hook', kind: 'WEBHOOK', config: { url: 'https://ops.example.com/d' }, secret: WEBHOOK_SECRET, enabled: true })).id;
    // Created as a disabled draft; enabled by a second person's approval.
    await approver.approve(ctx(admin), 'notification_destination', hookId, 'ACTIVATE');
  });

  it('retries transient failures via a typed retriable error, then marks SENT', async () => {
    const id = await delivery(hookId);
    responses = [503];
    const error = await svc().deliver(id).catch((e: unknown) => e);
    expect(isAlertDeliveryRetryable(error)).toBe(true);
    expect(error).toMatchObject({ retriable: true, category: 'provider_unavailable', code: 'alert_delivery_retry' });
    expect(await load(id)).toMatchObject({ status: 'PENDING', attempts: 1, lastError: 'HTTP 503' });
    responses = [200];
    requests.length = 0;
    expect(await svc().deliver(id)).toEqual({ status: 'SENT', attempts: 2 });
    expect(await load(id)).toMatchObject({ status: 'SENT', attempts: 2, lastError: null });
    expect(JSON.parse(requests[0]!.body)).toMatchObject({ deliveryId: id, deployment: 'My organization · PROD', alert: { alertId, link: `https://ocso.test/alerts/${alertId}` } });
    expect(await svc().deliver(id)).toEqual({ status: 'SKIPPED', reason: 'already_sent' });
  });

  it('fails permanently on non-retriable errors and when attempts are exhausted', async () => {
    const gone = await delivery(hookId);
    responses = [410];
    expect(await svc().deliver(gone)).toEqual({ status: 'FAILED', attempts: 1, error: 'HTTP 410' });
    const flaky = await delivery(hookId);
    responses = [503, 503];
    await expect(svc(2).deliver(flaky)).rejects.toMatchObject({ retriable: true });
    expect(await svc(2).deliver(flaky)).toEqual({ status: 'FAILED', attempts: 2, error: 'HTTP 503' });
    expect(JSON.stringify(await load(flaky))).not.toContain(WEBHOOK_SECRET);
  });

  it('handles disabled destinations, in-app no-ops and missing rows', async () => {
    const inApp = await destinations().create(ctx(admin), { name: 'In-app', kind: 'IN_APP', config: {}, enabled: true });
    // A draft (never approved) is inert: nothing is delivered through it.
    expect(await svc().deliver(await delivery(inApp.id))).toMatchObject({ status: 'FAILED', error: 'destination removed or disabled' });
    await approver.approve(ctx(admin), 'notification_destination', inApp.id, 'ACTIVATE');
    expect(await svc().deliver(await delivery(inApp.id))).toEqual({ status: 'SENT', attempts: 1 });
    const off = await destinations().create(ctx(admin), { name: 'Off', kind: 'IN_APP', config: {}, enabled: false });
    expect(await svc().deliver(await delivery(off.id))).toMatchObject({ status: 'FAILED', error: 'destination removed or disabled' });
    expect(await svc().deliver(uuidv7())).toEqual({ status: 'SKIPPED', reason: 'missing' });
  });

  it('works as the alert.deliver queue consumer and re-dispatches stale PENDING rows', async () => {
    const q = new MemoryQueue();
    const id = await delivery(hookId);
    await t.db.execute(sql`UPDATE alert_deliveries SET created_at = now() - interval '1 hour' WHERE id = ${id}`);
    expect(await svc().redispatchPending(q, 300)).toBeGreaterThanOrEqual(1);
    responses = [502];
    const service = svc();
    const outcomes: string[] = [];
    const sub = q.consume<{ deliveryId: string }>(
      'alert.deliver',
      async (message) => {
        try {
          outcomes.push((await service.deliver(message.payload.deliveryId)).status);
          return { kind: 'ack' };
        } catch (error) {
          if (isAlertDeliveryRetryable(error)) return { kind: 'retry', delaySeconds: 0, reason: error.code };
          throw error;
        }
      },
      { concurrency: 1, visibilityTimeoutSeconds: 30, maxAttempts: 5, pollIntervalMs: 10 },
    );
    const deadline = Date.now() + 5000;
    while ((await load(id)).status !== 'SENT' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    await sub.stop();
    expect(await load(id)).toMatchObject({ status: 'SENT', attempts: 2 });
  });
});

describe('default rules seed', () => {
  it('is idempotent and routes to in-app delivery', async () => {
    const first = await seedDefaultAlertRules(t.db);
    expect(first.created).toHaveLength(8);
    const second = await seedDefaultAlertRules(t.db);
    expect(second).toMatchObject({ created: [], existing: 8, destinationId: first.destinationId });
    const seeded = await t.db.select().from(alertRules).where(sql`${alertRules.destinationIds} @> ARRAY[${first.destinationId}]::uuid[]`);
    expect(seeded).toHaveLength(8);
    expect(seeded.find((r) => r.condition === 'provider_error_rate_above')!.params).toEqual({ thresholdPercent: 5, minRequests: 20 });
    expect(seeded.filter((r) => r.kind === 'BUSINESS').map((r) => r.condition).sort()).toEqual(['escalation_rate_above', 'sla_breaches_above']);
    const [dest] = await t.db.select().from(notificationDestinations).where(eq(notificationDestinations.id, first.destinationId));
    expect(dest!.kind).toBe('IN_APP');
  });
});
