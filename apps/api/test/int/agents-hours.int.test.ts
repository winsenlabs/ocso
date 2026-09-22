import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { completeSetup, startApi, type ApiHarness } from './harness.js';
import { teamOf } from './teams.js';

/** Agent business hours through the HTTP API: create/update, path-addressed validation, audit, permissions. */

let h: ApiHarness;
let lead: string;
let exec: string;
let agentId: string;
let team: string;
const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const HOURS = { timezone: 'Asia/Kolkata', humanHours: { mon: ['08:00', '23:00'], tue: ['08:00', '23:00'] } };

beforeAll(async () => {
  h = await startApi();
  const admin = await completeSetup(h);
  const mk = (email: string, role: string) => h.http().post('/v1/users').set(auth(admin)).send({ email, name: email.split('@')[0], role, password: 'a password 12345' }).expect(201);
  const leadId = (await mk('lead@ocso.test', 'CS_LEAD')).body.id;
  const execId = (await mk('exec@ocso.test', 'CS_EXEC')).body.id;
  lead = await h.loginAs('lead@ocso.test', 'a password 12345');
  exec = await h.loginAs('exec@ocso.test', 'a password 12345');
  // Lead and exec share the team that owns the agents (ADR-026).
  team = await teamOf(h, { admin, lead }, 'Cards', [leadId, execId]);
});
afterAll(async () => {
  await h?.close();
});

describe('agent business hours API', () => {
  it('creates an agent with business hours and defaults to humans 24×7 without them', async () => {
    const created = await h.http().post('/v1/agents').set(auth(lead)).send({ name: 'Maya', purpose: 'Customer Support', description: 'Cards', conversationType: 'SUPPORT', businessHours: HOURS, teamIds: [team] }).expect(201);
    agentId = created.body.id;
    expect(created.body.businessHours).toEqual(HOURS);
    const plain = await h.http().post('/v1/agents').set(auth(lead)).send({ name: 'Arjun', conversationType: 'SALES', teamIds: [team] }).expect(201);
    expect(plain.body.businessHours).toEqual({ timezone: 'UTC', humanHours: {} });
  });

  it('rejects invalid hours with path-addressed messages', async () => {
    const res = await h
      .http()
      .patch(`/v1/agents/${agentId}`)
      .set(auth(lead))
      .send({ businessHours: { timezone: 'Asia/Nowhere', humanHours: { mon: ['18:00', '09:00'], tue: ['9:00', '17:00'], funday: ['09:00', '10:00'] } } })
      .expect(400);
    expect(res.body.error.category).toBe('validation');
    const message: string = res.body.error.message;
    expect(message).toContain('businessHours.timezone: Unknown time zone');
    expect(message).toContain('businessHours.humanHours.mon: Opening time must be before closing time');
    expect(message).toContain('businessHours.humanHours.tue.0: Opening time must be HH:MM');
    expect(message).toContain('businessHours.humanHours: Unknown day funday');
    const unchanged = await h.http().get(`/v1/agents/${agentId}`).set(auth(lead)).expect(200);
    expect(unchanged.body.businessHours).toEqual(HOURS);
  });

  it('updates hours (24×7 as empty), audits the change and refuses roles without agents.manage', async () => {
    await h.http().patch(`/v1/agents/${agentId}`).set(auth(exec)).send({ businessHours: { timezone: 'UTC', humanHours: {} } }).expect(403);
    const next = { timezone: 'Europe/London', humanHours: { sat: ['10:00', '24:00'] } };
    const res = await h.http().patch(`/v1/agents/${agentId}`).set(auth(lead)).send({ businessHours: next }).expect(200);
    expect(res.body.businessHours).toEqual(next);
    // A hours-only patch leaves the other fields alone.
    expect(res.body).toMatchObject({ name: 'Maya', purpose: 'Customer Support', description: 'Cards' });
    await h.http().patch(`/v1/agents/${agentId}`).set(auth(lead)).send({ businessHours: { timezone: 'Europe/London', humanHours: {} } }).expect(200);
    const { rows } = await h.db.pool.query(`SELECT summary FROM audit_events WHERE action = 'agent.update' AND target_id = $1 ORDER BY occurred_at`, [agentId]);
    expect(rows.map((r: { summary: string }) => r.summary)).toEqual(['Updated Maya · business hours sat 10:00–24:00 (Europe/London)', 'Updated Maya · business hours humans 24×7']);
  });
});
