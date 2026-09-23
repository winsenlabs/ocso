import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@ocso/db';
import { completeSetup, startApi, type ApiHarness } from './harness.js';

let h: ApiHarness;
const tokens = { admin: '', lead: '', exec: '' };
const ids = { technical: uuidv7(), business: uuidv7(), leadOnly: uuidv7() };

const as = (who: keyof typeof tokens) => ({ authorization: `Bearer ${tokens[who]}` });

async function createUser(role: 'HEAD' | 'SERVICE', email: string): Promise<string> {
  await h.http().post('/v1/users').set(as('admin')).send({ email, name: role, role, password: 'correct password 1234' }).expect(201);
  return h.loginAs(email, 'correct password 1234');
}

async function insertAlert(id: string, kind: 'TECHNICAL' | 'BUSINESS', audience: string[], title: string) {
  await h.db.pool.query(
    `INSERT INTO alerts (id, fingerprint, kind, severity, title, body, audience_roles, source) VALUES ($1, $2, $3, 'WARNING', $4, 'body', $5, 'test')`,
    [id, `fp-${id}`, kind, title, audience],
  );
}

beforeAll(async () => {
  h = await startApi();
  tokens.admin = await completeSetup(h);
  tokens.lead = await createUser('HEAD', 'lead@ocso.test');
  tokens.exec = await createUser('SERVICE', 'exec@ocso.test');
  await insertAlert(ids.technical, 'TECHNICAL', ['TECH'], 'Provider error rate above 5%');
  await insertAlert(ids.business, 'BUSINESS', ['HEAD', 'SERVICE'], 'SLA breaches · Maya');
  await insertAlert(ids.leadOnly, 'BUSINESS', ['HEAD'], 'Escalation rate above 25% · Maya');
});
afterAll(async () => {
  await h?.close();
});

describe('alerts API RBAC', () => {
  it('scopes the alert list by audience role and readable kind', async () => {
    const execList = await h.http().get('/v1/alerts').set(as('exec')).expect(200);
    expect(execList.body.items.map((a: { id: string }) => a.id)).toEqual([ids.business]);
    const leadList = await h.http().get('/v1/alerts?status=OPEN').set(as('lead')).expect(200);
    expect(leadList.body.items.map((a: { id: string }) => a.id).sort()).toEqual([ids.business, ids.leadOnly].sort());
    const adminList = await h.http().get('/v1/alerts').set(as('admin')).expect(200);
    expect(adminList.body.items.map((a: { kind: string }) => a.kind)).toEqual(['TECHNICAL']);

    const denied = await h.http().get('/v1/alerts?kind=TECHNICAL').set(as('exec')).expect(403);
    expect(denied.body.error.category).toBe('authorization');
    await h.http().get(`/v1/alerts/${ids.technical}`).set(as('exec')).expect(404);
    await h.http().get('/v1/alerts?status=NOPE').set(as('exec')).expect(400);
    await h.http().get('/v1/alerts').expect(401);

    const counts = await h.http().get('/v1/alerts/counts').set(as('exec')).expect(200);
    expect(counts.body).toMatchObject({ unresolved: 1, open: 1, byKind: { BUSINESS: 1 } });
    expect(counts.body.byKind.TECHNICAL).toBeUndefined();
  });

  it('lets Service members acknowledge and resolve business alerts they can see, with a note', async () => {
    await h.http().post(`/v1/alerts/${ids.business}/acknowledge`).set(as('admin')).send({}).expect(404);
    const acked = await h.http().post(`/v1/alerts/${ids.business}/acknowledge`).set(as('exec')).expect(200);
    expect(acked.body).toMatchObject({ id: ids.business, status: 'ACKNOWLEDGED' });
    await h.http().post(`/v1/alerts/${ids.business}/resolve`).set(as('exec')).send({}).expect(400);
    const resolved = await h.http().post(`/v1/alerts/${ids.business}/resolve`).set(as('exec')).send({ note: 'All breached chats picked up' }).expect(200);
    expect(resolved.body).toMatchObject({ status: 'RESOLVED', resolution: 'All breached chats picked up' });
    const again = await h.http().post(`/v1/alerts/${ids.business}/resolve`).set(as('exec')).send({ note: 'x' }).expect(409);
    expect(again.body.error.code).toBe('alert_resolved');
  });

  it('enforces rule management per kind: Service member none, Lead business only, Tech admin technical only', async () => {
    const technical = { name: 'Workers', kind: 'TECHNICAL', condition: 'workers_below_min', audienceRoles: ['TECH'] };
    const business = { name: 'Escalations', kind: 'BUSINESS', condition: 'escalation_rate_above', params: { thresholdPercent: 20 }, audienceRoles: ['HEAD', 'SERVICE'] };
    await h.http().post('/v1/alert-rules').set(as('exec')).send(business).expect(403);
    await h.http().post('/v1/alert-rules').set(as('exec')).send(technical).expect(403);
    await h.http().post('/v1/alert-rules').set(as('lead')).send(technical).expect(403);
    await h.http().post('/v1/alert-rules').set(as('admin')).send(business).expect(403);
    // A technical condition cannot be smuggled in under the business kind.
    const smuggled = await h.http().post('/v1/alert-rules').set(as('lead')).send({ ...technical, kind: 'BUSINESS', audienceRoles: ['HEAD'] }).expect(400);
    expect(smuggled.body.error.code).toBe('condition_kind_mismatch');

    const leadRule = await h.http().post('/v1/alert-rules').set(as('lead')).send(business).expect(201);
    expect(leadRule.body).toMatchObject({ kind: 'BUSINESS', params: { thresholdPercent: 20, minConversations: 20 } });
    const adminRule = await h.http().post('/v1/alert-rules').set(as('admin')).send(technical).expect(201);

    await h.http().patch(`/v1/alert-rules/${adminRule.body.id}`).set(as('lead')).send({ enabled: false }).expect(403);
    await h.http().delete(`/v1/alert-rules/${adminRule.body.id}`).set(as('lead')).expect(403);
    await h.http().get(`/v1/alert-rules/${adminRule.body.id}`).set(as('exec')).expect(404);
    const execRules = await h.http().get('/v1/alert-rules').set(as('exec')).expect(200);
    // Setup seeds the default rules; an exec can read business rules only.
    const execRuleIds = execRules.body.map((r: { id: string }) => r.id);
    expect(execRuleIds).toContain(leadRule.body.id);
    expect(execRuleIds).not.toContain(adminRule.body.id);
    expect(execRules.body.every((r: { kind: string }) => r.kind === 'BUSINESS')).toBe(true);
    const execConditions = await h.http().get('/v1/alert-rules/conditions').set(as('exec')).expect(200);
    expect(execConditions.body.every((c: { kinds: string[] }) => c.kinds.includes('BUSINESS'))).toBe(true);

    await h.http().patch(`/v1/alert-rules/${leadRule.body.id}`).set(as('lead')).send({ severity: 'CRITICAL' }).expect(200);
    await h.http().delete(`/v1/alert-rules/${adminRule.body.id}`).set(as('admin')).expect(204);
  });

  it('restricts notification destinations to managers and never returns secrets', async () => {
    const hook = { name: 'Ops webhook', kind: 'WEBHOOK', config: { url: 'https://ops.example.com/hook' }, secret: 'whsec_api_secret_value_99' };
    await h.http().post('/v1/notification-destinations').set(as('lead')).send(hook).expect(403);
    const created = await h.http().post('/v1/notification-destinations').set(as('admin')).send(hook).expect(201);
    expect(created.body).toMatchObject({ kind: 'WEBHOOK', hasSecret: true });
    expect(JSON.stringify(created.body)).not.toContain('whsec_');

    const leadView = await h.http().get('/v1/notification-destinations').set(as('lead')).expect(200);
    expect(leadView.body.find((d: { id: string }) => d.id === created.body.id)).toMatchObject({ config: null, hasSecret: true });
    await h.http().get('/v1/notification-destinations').set(as('exec')).expect(403);
    await h.http().post(`/v1/notification-destinations/${created.body.id}/test`).set(as('lead')).expect(403);

    const inApp = await h.http().post('/v1/notification-destinations').set(as('admin')).send({ name: 'In-app', kind: 'IN_APP' }).expect(201);
    const test = await h.http().post(`/v1/notification-destinations/${inApp.body.id}/test`).set(as('admin')).expect(200);
    expect(test.body).toEqual({ ok: true, retriable: false });
    await h.http().delete(`/v1/notification-destinations/${inApp.body.id}`).set(as('admin')).expect(204);
  });

  it('serves destination kinds from the delivery registry and validates kinds against it', async () => {
    const kinds = await h.http().get('/v1/notification-destinations/kinds').set(as('admin')).expect(200);
    const byKind = new Map(kinds.body.map((k: { kind: string }) => [k.kind, k]));
    expect([...byKind.keys()]).toEqual(expect.arrayContaining(['IN_APP', 'EMAIL', 'WEBHOOK', 'PAGERDUTY']));
    expect(byKind.get('PAGERDUTY')).toMatchObject({ label: 'PagerDuty', events: ['OPENED', 'ACKNOWLEDGED', 'RESOLVED', 'REMINDER'], secret: { label: 'Events API v2 routing key', required: true } });
    expect(byKind.get('IN_APP')).toMatchObject({ secret: null, configSchema: { type: 'object' } });
    // Rule editors attach destinations, so they may read the kinds; an exec may not.
    await h.http().get('/v1/notification-destinations/kinds').set(as('lead')).expect(200);
    await h.http().get('/v1/notification-destinations/kinds').set(as('exec')).expect(403);

    const unknown = await h.http().post('/v1/notification-destinations').set(as('admin')).send({ name: 'Pager', kind: 'SMS_GATEWAY' }).expect(400);
    expect(JSON.stringify(unknown.body)).toContain('unsupported_destination_kind');

    const created = await h.http().post('/v1/notification-destinations').set(as('admin')).send({ name: 'Incidents EU', kind: 'PAGERDUTY', config: { region: 'EU' }, secret: 'R0ut1ngKeyR0ut1ngKey42' }).expect(201);
    expect(created.body).toMatchObject({ summary: 'region EU', config: { region: 'EU' } });
    const leadView = await h.http().get('/v1/notification-destinations').set(as('lead')).expect(200);
    expect(leadView.body.find((d: { id: string }) => d.id === created.body.id)).toMatchObject({ config: null, summary: null });
    await h.http().delete(`/v1/notification-destinations/${created.body.id}`).set(as('admin')).expect(204);
  });
});
