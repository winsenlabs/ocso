import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Principal } from '@ocso/auth';
import { SettingsService, recordInstalledApproval } from '@ocso/application';
import { modelProfiles, modelProviders, uuidv7 } from '@ocso/db';
import { createEvent } from '@ocso/events';
import { RealtimeAccess } from '../../src/modules/realtime/realtime-access.js';
import { completeSetup, startApi, type ApiHarness } from './harness.js';
import { createTeam, setTeams } from './teams.js';

/**
 * Who sees which proposal (PM/research/11b "Scoping"): a Head of another team
 * sees nothing of it (404), Tech with approvals.reassign_any sees every open
 * one, a Service member sees their team's; audit rows about a proposal and the
 * realtime notices follow the same people.
 */
let h: ApiHarness;
const tok = { admin: '', lead: '', head: '', headLoans: '', service: '' };
const ids: Record<string, string> = {};
const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const PASSWORD = 'a password 12345';

beforeAll(async () => {
  h = await startApi();
  tok.admin = await completeSetup(h);
  const mk = async (email: string, name: string, role: string) => (await h.http().post('/v1/users').set(auth(tok.admin)).send({ email, name, role, password: PASSWORD }).expect(201)).body.id as string;
  ids.lead = await mk('lena@ocso.test', 'Lena Lead', 'LEAD');
  ids.head = await mk('anjali@ocso.test', 'Anjali Rao', 'HEAD');
  ids.headLoans = await mk('rohan@ocso.test', 'Rohan Kapoor', 'HEAD');
  ids.service = await mk('nikhil@ocso.test', 'Nikhil Menon', 'SERVICE');
  for (const [k, email] of [['lead', 'lena'], ['head', 'anjali'], ['headLoans', 'rohan'], ['service', 'nikhil']] as const) tok[k] = await h.loginAs(`${email}@ocso.test`, PASSWORD);
  ids.cards = await createTeam(h, tok.head, 'Cards');
  ids.loans = await createTeam(h, tok.headLoans, 'Loans');
  for (const who of ['lead', 'head', 'service'] as const) await setTeams(h, tok.admin, ids[who]!, [ids.cards]);
  await setTeams(h, tok.admin, ids.headLoans!, [ids.loans]);
  ids.provider = uuidv7();
  ids.profile = uuidv7();
  await h.db.db.insert(modelProviders).values({ id: ids.provider, kind: 'DEV_SCRIPTED', name: 'Scripted' });
  await h.db.db.insert(modelProfiles).values({ id: ids.profile, name: 'support-fast', providerId: ids.provider, model: 'scripted-1' });
  // An existing profile (grandfathered like 0031): agents go live only on approved profiles.
  await recordInstalledApproval(h.db.db, { kind: 'model_profile', id: ids.profile, title: 'support-fast' }, 'Test fixture: existing profile');
  ids.maya = (await h.http().post('/v1/agents').set(auth(tok.lead)).send({ name: 'Maya', conversationType: 'SUPPORT', modelProfileId: ids.profile, teamIds: [ids.cards] }).expect(201)).body.id;
  ids.proposal = (
    await h.http().post(`/v1/agents/${ids.maya}/status`).set(auth(tok.lead)).send({ status: 'LIVE', approval: { checkerId: ids.head, reason: 'Ready' } }).expect(202)
  ).body.proposal.id;
});
afterAll(async () => {
  await h?.close();
});

describe('approval scoping over HTTP', () => {
  it('another team’s Head neither lists nor opens it, and cannot learn the agent’s checkers', async () => {
    for (const box of ['AWAITING_ME', 'SENT_BY_ME', 'DECIDED']) {
      const res = await h.http().get('/v1/approvals').query({ box }).set(auth(tok.headLoans)).expect(200);
      // Platform-wide configuration installed at setup (default alert rules, recorded like grandfathered config) is
      // visible to every checker; nothing of the Cards team is.
      expect(res.body.rows.filter((r: { origin: string }) => r.origin !== 'MIGRATION')).toEqual([]);
    }
    await h.http().get(`/v1/approvals/${ids.proposal}`).set(auth(tok.headLoans)).expect(404);
    await h.http().get('/v1/approvals/checkers').query({ objectKind: 'agent', objectId: ids.maya }).set(auth(tok.headLoans)).expect(404);
    await h.http().post(`/v1/approvals/${ids.proposal}/checker`).set(auth(tok.headLoans)).send({ checkerId: ids.headLoans, reason: 'mine now' }).expect(404);
  });

  it('Tech (approvals.reassign_any) sees every open proposal; others cannot ask for “all open”', async () => {
    const res = await h.http().get('/v1/approvals').query({ box: 'OPEN' }).set(auth(tok.admin)).expect(200);
    expect(res.body.rows.map((r: { id: string }) => r.id)).toContain(ids.proposal);
    await h.http().get('/v1/approvals').query({ box: 'OPEN' }).set(auth(tok.service)).expect(403);
  });

  it('a Service member of the team reads it, with nothing to decide', async () => {
    const awaiting = await h.http().get('/v1/approvals').query({ box: 'AWAITING_ME' }).set(auth(tok.service)).expect(200);
    expect(awaiting.body.rows).toEqual([]);
    const detail = await h.http().get(`/v1/approvals/${ids.proposal}`).set(auth(tok.service)).expect(200);
    expect(detail.body).toMatchObject({ canDecide: false, canReassign: false, canEdit: false });
  });

  it('audit rows about the proposal follow the same scope', async () => {
    const cards = await h.http().get('/v1/audit').query({ targetType: 'approval' }).set(auth(tok.head)).expect(200);
    expect(cards.body.map((r: { targetId: string }) => r.targetId)).toContain(ids.proposal);
    const loans = await h.http().get('/v1/audit').query({ targetType: 'approval' }).set(auth(tok.headLoans)).expect(200);
    expect(loans.body).toEqual([]);
  });

  it('realtime approval notices reach the maker, the checker and reassign_any holders only', async () => {
    const event = createEvent('approval.requested', { proposalId: ids.proposal!, objectKind: 'agent', objectId: ids.maya!, action: 'ACTIVATE', makerId: ids.lead!, checkerId: ids.head! }, { correlationId: 'c' });
    const settings = new SettingsService(h.db.db);
    const principal = (userId: string, role: Principal['role'], teamIds: string[]): Principal => ({ userId, role, displayName: role, teamIds, via: 'UI' });
    const allows = (p: Principal) => new RealtimeAccess(h.db.db, settings, p).allows(event);
    expect(await allows(principal(ids.lead!, 'LEAD', [ids.cards!]))).toBe(true);
    expect(await allows(principal(ids.head!, 'HEAD', [ids.cards!]))).toBe(true);
    expect(await allows(principal(uuidv7(), 'TECH', []))).toBe(true);
    expect(await allows(principal(ids.service!, 'SERVICE', [ids.cards!]))).toBe(false);
    expect(await allows(principal(ids.headLoans!, 'HEAD', [ids.loans!]))).toBe(false);
  });
});
