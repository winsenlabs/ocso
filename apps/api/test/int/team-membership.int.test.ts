import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { completeSetup, startApi, type ApiHarness } from './harness.js';

/**
 * Team membership (ADR-026): the CS Lead who creates a team joins it; a CS Lead
 * manages CS Exec memberships (and their own) only on teams they belong to; the
 * Tech Admin manages every membership.
 */
let h: ApiHarness;
const t = { admin: '', lead: '', lead2: '' };
const ids: Record<string, string> = {};
const as = (who: keyof typeof t) => ({ authorization: `Bearer ${t[who]}` });
const PASSWORD = 'a password 12345';

beforeAll(async () => {
  h = await startApi();
  t.admin = await completeSetup(h);
  const mk = async (key: string, role: string) => {
    ids[key] = (await h.http().post('/v1/users').set(as('admin')).send({ email: `${key}@ocso.test`, name: key, role, password: PASSWORD }).expect(201)).body.id;
  };
  await mk('lead', 'CS_LEAD');
  await mk('lead2', 'CS_LEAD');
  await mk('exec', 'CS_EXEC');
  t.lead = await h.loginAs('lead@ocso.test', PASSWORD);
  t.lead2 = await h.loginAs('lead2@ocso.test', PASSWORD);
});
afterAll(async () => {
  await h?.close();
});

const members = async (teamId: string) => ((await h.http().get('/v1/users').set(as('admin')).expect(200)).body as Array<{ id: string; teamIds: string[] }>).filter((u) => u.teamIds.includes(teamId)).map((u) => u.id).sort();

describe('team membership', () => {
  it('the creating lead joins the team', async () => {
    const team = await h.http().post('/v1/teams').set(as('lead')).send({ name: 'Cards' }).expect(201);
    ids['cards'] = team.body.id;
    expect(team.body.memberCount).toBe(1);
    expect(await members(ids['cards']!)).toEqual([ids['lead']]);
    ids['loans'] = (await h.http().post('/v1/teams').set(as('lead2')).send({ name: 'Loans' }).expect(201)).body.id;
  });

  it('a lead adds and removes CS Execs on their own teams only', async () => {
    await h.http().post(`/v1/teams/${ids['cards']}/members`).set(as('lead')).send({ userId: ids['exec'] }).expect(204);
    expect(await members(ids['cards']!)).toEqual([ids['exec'], ids['lead']].sort());
    await h.http().post(`/v1/teams/${ids['loans']}/members`).set(as('lead')).send({ userId: ids['exec'] }).expect(403);
    await h.http().post(`/v1/teams/${ids['cards']}/members`).set(as('lead')).send({ userId: ids['lead2'] }).expect(403);
    await h.http().patch(`/v1/users/${ids['exec']}`).set(as('lead')).send({ teamIds: [ids['cards'], ids['loans']] }).expect(403);
    await h.http().delete(`/v1/teams/${ids['cards']}/members/${ids['exec']}`).set(as('lead')).expect(204);
    await h.http().patch(`/v1/users/${ids['exec']}`).set(as('lead')).send({ teamIds: [ids['cards']] }).expect(200);
  });

  it('a lead may leave a team, and then no longer manages it; the Tech Admin manages everything', async () => {
    await h.http().delete(`/v1/teams/${ids['cards']}/members/${ids['lead']}`).set(as('lead')).expect(204);
    const lead = await h.loginAs('lead@ocso.test', PASSWORD);
    await h.http().delete(`/v1/teams/${ids['cards']}/members/${ids['exec']}`).set({ authorization: `Bearer ${lead}` }).expect(403);
    await h.http().post(`/v1/teams/${ids['cards']}/members`).set(as('admin')).send({ userId: ids['lead'] }).expect(204);
    await h.http().post(`/v1/teams/${ids['loans']}/members`).set(as('admin')).send({ userId: ids['lead'] }).expect(204);
    expect(await members(ids['loans']!)).toEqual([ids['lead'], ids['lead2']].sort());
    await h.http().post(`/v1/teams/${ids['cards']}/members`).set(as('admin')).send({ userId: '00000000-0000-7000-8000-000000000000' }).expect(404);
    const { rows } = await h.db.pool.query(`SELECT action FROM audit_events WHERE action LIKE 'team.member_%'`);
    expect(rows.length).toBeGreaterThanOrEqual(5);
  });

  it('a CS Exec cannot change memberships', async () => {
    const exec = await h.loginAs('exec@ocso.test', PASSWORD);
    await h.http().post(`/v1/teams/${ids['cards']}/members`).set({ authorization: `Bearer ${exec}` }).send({ userId: ids['exec'] }).expect(403);
  });
});
