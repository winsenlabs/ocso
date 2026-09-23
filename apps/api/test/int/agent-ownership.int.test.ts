import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { alerts, conversations, customers, uuidv7 } from '@ocso/db';
import type { Principal } from '@ocso/auth';
import { SettingsService } from '@ocso/application';
import { createEvent } from '@ocso/events';
import { RealtimeAccess } from '../../src/modules/realtime/realtime-access.js';
import { completeSetup, startApi, type ApiHarness } from './harness.js';
import { createTeam, setTeams } from './teams.js';

/**
 * Team-scoped agent ownership over HTTP (ADR-026): lead B gets 404 on every
 * route of lead A's agent, the owners route is Tech admin governance, and the
 * realtime filter uses the same scopes as the REST reads.
 */

let h: ApiHarness;
const tok = { admin: '', leadA: '', leadB: '', execB: '' };
const ids: Record<string, string> = {};
const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const PASSWORD = 'a password 12345';

beforeAll(async () => {
  h = await startApi();
  tok.admin = await completeSetup(h);
  const mk = async (email: string, role: string) => (await h.http().post('/v1/users').set(auth(tok.admin)).send({ email, name: email.split('@')[0], role, password: PASSWORD }).expect(201)).body.id as string;
  ids.leadA = await mk('lead.a@ocso.test', 'HEAD');
  ids.leadB = await mk('lead.b@ocso.test', 'HEAD');
  ids.execB = await mk('exec.b@ocso.test', 'SERVICE');
  for (const k of ['leadA', 'leadB', 'execB'] as const) tok[k] = await h.loginAs(`${k.replace('lead', 'lead.').replace('exec', 'exec.').toLowerCase()}@ocso.test`, PASSWORD);
  ids.cards = await createTeam(h, tok.leadA, 'Cards');
  ids.loans = await createTeam(h, tok.leadB, 'Loans');
  await setTeams(h, tok.admin, ids.leadA, [ids.cards]);
  await setTeams(h, tok.admin, ids.leadB, [ids.loans]);
  await setTeams(h, tok.admin, ids.execB, [ids.loans]);
  ids.loansQueue = (await h.http().post('/v1/queues').set(auth(tok.leadB)).send({ name: 'Loans desk', teamIds: [ids.loans] }).expect(201)).body.id;
  ids.maya = (await h.http().post('/v1/agents').set(auth(tok.leadA)).send({ name: 'Maya', conversationType: 'SUPPORT', teamIds: [ids.cards] }).expect(201)).body.id;
  ids.arjun = (await h.http().post('/v1/agents').set(auth(tok.leadB)).send({ name: 'Arjun', conversationType: 'SALES', teamIds: [ids.loans], defaultQueueId: ids.loansQueue }).expect(201)).body.id;
  const customer = uuidv7();
  await h.db.db.insert(customers).values({ id: customer, displayName: 'Priya Deshmukh' });
  ids.c1 = uuidv7();
  ids.c2 = uuidv7();
  await h.db.db.insert(conversations).values([
    { id: ids.c1, customerId: customer, agentId: ids.maya!, type: 'SUPPORT', controlState: 'WAITING_FOR_HUMAN' },
    { id: ids.c2, customerId: customer, agentId: ids.maya!, type: 'SUPPORT', controlState: 'WAITING_FOR_HUMAN', queueId: ids.loansQueue! },
  ]);
  ids.alert = uuidv7();
  await h.db.db.insert(alerts).values({ id: ids.alert, fingerprint: 'f-maya', kind: 'BUSINESS', severity: 'WARNING', title: 'Escalation rate · Maya', body: 'b', source: 's', audienceRoles: ['HEAD'], context: { agentId: ids.maya! } });
});
afterAll(async () => {
  await h?.close();
});

describe('agents API with team ownership', () => {
  it('lists the caller’s agents with their owning teams', async () => {
    const a = await h.http().get('/v1/agents').set(auth(tok.leadA)).expect(200);
    expect(a.body.map((x: { name: string; teams: Array<{ name: string }> }) => [x.name, x.teams.map((t) => t.name)])).toEqual([['Maya', ['Cards']]]);
    const admin = await h.http().get('/v1/agents').set(auth(tok.admin)).expect(200);
    expect(admin.body.map((x: { name: string }) => x.name)).toEqual(['Arjun', 'Maya']);
  });

  it('answers 404 on every agent-scoped route of another team’s agent', async () => {
    const version = (await h.http().get(`/v1/agents/${ids.maya}/prompt`).set(auth(tok.leadA)).expect(200)).body.versions[0].id;
    const get404 = [
      `/v1/agents/${ids.maya}`,
      `/v1/agents/${ids.maya}/prompt`,
      `/v1/agents/${ids.maya}/prompt/preview`,
      `/v1/agents/${ids.maya}/prompt/diff?from=${version}&to=${version}`,
      `/v1/agents/${ids.maya}/escalation-rules`,
      `/v1/agents/${ids.maya}/tools`,
      `/v1/analytics/agents/${ids.maya}`,
      `/v1/reviews?agentId=${ids.maya}`,
      `/v1/corrections?agentId=${ids.maya}`,
      `/v1/evaluations?agentId=${ids.maya}`,
      `/v1/alerts?agentId=${ids.maya}`,
      `/v1/alerts/${ids.alert}`,
    ];
    for (const path of get404) {
      const res = await h.http().get(path).set(auth(tok.leadB));
      expect([path, res.status]).toEqual([path, 404]);
    }
    await h.http().patch(`/v1/agents/${ids.maya}`).set(auth(tok.leadB)).send({ purpose: 'x' }).expect(404);
    await h.http().post(`/v1/agents/${ids.maya}/status`).set(auth(tok.leadB)).send({ status: 'PAUSED' }).expect(404);
    await h.http().post(`/v1/agents/${ids.maya}/escalation-rules`).set(auth(tok.leadB)).send({ name: 'x', trigger: 'RISK' }).expect(404);
    await h.http().put(`/v1/agents/${ids.maya}/tools`).set(auth(tok.leadB)).send({ grants: [] }).expect(404);
    await h.http().put(`/v1/agents/${ids.maya}/owners`).set(auth(tok.leadB)).send({ teamIds: [ids.loans] }).expect(404);
    await h.http().post(`/v1/agents/${ids.maya}/prompt/versions/${version}/activate`).set(auth(tok.leadB)).expect(404);
  });

  it('rejects creating an agent without an owning team or for a team the lead is not in', async () => {
    await h.http().post('/v1/agents').set(auth(tok.leadA)).send({ name: 'Nobody’s', conversationType: 'SUPPORT' }).expect(400);
    const foreign = await h.http().post('/v1/agents').set(auth(tok.leadA)).send({ name: 'Sneaky', conversationType: 'SUPPORT', teamIds: [ids.loans] }).expect(400);
    expect(foreign.body.error.code).toBe('owner_team_not_member');
  });

  it('keeps the other team’s conversations out of the inbox unless routed to the lead’s queue', async () => {
    const b = await h.http().get('/v1/conversations?view=all').set(auth(tok.leadB)).expect(200);
    expect(b.body.items.map((i: { id: string }) => i.id)).toEqual([ids.c2]);
    await h.http().get(`/v1/conversations/${ids.c1}`).set(auth(tok.leadB)).expect(403);
    const a = await h.http().get('/v1/conversations?view=all').set(auth(tok.leadA)).expect(200);
    expect(a.body.items.map((i: { id: string }) => i.id).sort()).toEqual([ids.c1, ids.c2].sort());
  });

  it('lets only the Tech admin reassign across teams, audited', async () => {
    await h.http().put(`/v1/agents/${ids.maya}/owners`).set(auth(tok.execB)).send({ teamIds: [ids.loans] }).expect(403);
    await h.http().put(`/v1/agents/${ids.maya}/owners`).set(auth(tok.leadA)).send({ teamIds: [ids.loans] }).expect(400);
    await h.http().put(`/v1/agents/${ids.maya}/owners`).set(auth(tok.admin)).send({ teamIds: [] }).expect(400);
    const res = await h.http().put(`/v1/agents/${ids.maya}/owners`).set(auth(tok.admin)).send({ teamIds: [ids.cards, ids.loans] }).expect(200);
    expect(res.body.teams.map((t: { name: string }) => t.name)).toEqual(['Cards', 'Loans']);
    await h.http().get(`/v1/agents/${ids.maya}`).set(auth(tok.leadB)).expect(200);
    await h.http().patch(`/v1/agents/${ids.maya}`).set(auth(tok.admin)).send({ purpose: 'x' }).expect(403);
    const audit = await h.http().get(`/v1/audit?targetId=${ids.maya}`).set(auth(tok.admin)).expect(200);
    expect(JSON.stringify(audit.body)).toContain('Owning teams of Maya: Cards → Cards, Loans (reassigned by Tech admin)');
    await h.http().put(`/v1/agents/${ids.maya}/owners`).set(auth(tok.admin)).send({ teamIds: [ids.cards] }).expect(200);
  });
});

describe('realtime filter', () => {
  const principal = (userId: string, role: Principal['role'], teamIds: string[]): Principal => ({ userId, role, displayName: role, teamIds, via: 'UI' });

  it('delivers conversation, alert and config events only within the lead’s scope', async () => {
    const settings = new SettingsService(h.db.db);
    const leadB = new RealtimeAccess(h.db.db, settings, principal(ids.leadB!, 'HEAD', [ids.loans!]));
    const leadA = new RealtimeAccess(h.db.db, settings, principal(ids.leadA!, 'HEAD', [ids.cards!]));
    const conv = (id: string) => createEvent('conversation.updated', { fields: ['controlState'] }, { correlationId: 'rt', conversationId: id, agentId: ids.maya });
    const alert = createEvent('alert.opened', { alertId: ids.alert!, severity: 'WARNING', kind: 'BUSINESS' }, { correlationId: 'rt', agentId: ids.maya });
    const config = createEvent('config.changed', { area: 'agent', entityId: ids.maya! }, { correlationId: 'rt', agentId: ids.maya });
    expect(await leadB.allows(conv(ids.c1!))).toBe(false);
    expect(await leadB.allows(conv(ids.c2!))).toBe(true); // routed to the Loans queue
    expect(await leadB.allows(alert)).toBe(false);
    expect(await leadB.allows(config)).toBe(false);
    expect(await leadA.allows(conv(ids.c1!))).toBe(true);
    expect(await leadA.allows(alert)).toBe(true);
    expect(await leadA.allows(config)).toBe(true);
  });
});
