import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { ApprovalNotifier, createApprovalRegistry, recordInstalledApproval, type ApprovalNotifyJob } from '@ocso/application';
import { jobs, modelProfiles, modelProviders, uuidv7 } from '@ocso/db';
import type { EmailSender } from '@ocso/email';
import { EMAIL_SENDER } from '../../src/infrastructure/tokens.js';
import { completeSetup, startApi, type ApiHarness } from './harness.js';
import { createTeam, setTeams } from './teams.js';

/**
 * Maker–checker over HTTP (PM/research/11 §4, 11b): the 409/202 submission UX
 * on agent write endpoints, the approval queue, decisions with the content
 * hash, reassignment, bulk approve, and the emails the worker would send.
 */
let h: ApiHarness;
const tok = { admin: '', lead: '', head: '', head2: '', service: '' };
const ids: Record<string, string> = {};
const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const PASSWORD = 'a password 12345';

/** Deliver the queued approval.notify jobs the way the worker's consumer does. */
async function deliverNotices(): Promise<void> {
  const notifier = new ApprovalNotifier({ db: h.db.db, registry: createApprovalRegistry(), email: h.app.get<EmailSender>(EMAIL_SENDER), baseUrl: 'https://ocso.example' });
  const queued = await h.db.db.select().from(jobs).where(eq(jobs.topic, 'approval.notify'));
  for (const job of queued) {
    await notifier.handle(job.payload as ApprovalNotifyJob);
    await h.db.db.delete(jobs).where(eq(jobs.id, job.id));
  }
}

beforeAll(async () => {
  h = await startApi();
  tok.admin = await completeSetup(h);
  const mk = async (email: string, name: string, role: string) => (await h.http().post('/v1/users').set(auth(tok.admin)).send({ email, name, role, password: PASSWORD }).expect(201)).body.id as string;
  ids.lead = await mk('lena@ocso.test', 'Lena Lead', 'LEAD');
  ids.head = await mk('anjali@ocso.test', 'Anjali Rao', 'HEAD');
  ids.head2 = await mk('priya@ocso.test', 'Priya Nair', 'HEAD');
  ids.service = await mk('nikhil@ocso.test', 'Nikhil Menon', 'SERVICE');
  tok.lead = await h.loginAs('lena@ocso.test', PASSWORD);
  tok.head = await h.loginAs('anjali@ocso.test', PASSWORD);
  tok.head2 = await h.loginAs('priya@ocso.test', PASSWORD);
  tok.service = await h.loginAs('nikhil@ocso.test', PASSWORD);
  ids.cards = await createTeam(h, tok.head, 'Cards');
  for (const who of ['lead', 'head', 'head2', 'service'] as const) await setTeams(h, tok.admin, ids[who]!, [ids.cards]);
  ids.provider = uuidv7();
  ids.profile = uuidv7();
  await h.db.db.insert(modelProviders).values({ id: ids.provider, kind: 'DEV_SCRIPTED', name: 'Scripted' });
  await h.db.db.insert(modelProfiles).values({ id: ids.profile, name: 'support-fast', providerId: ids.provider, model: 'scripted-1' });
  // An existing profile (grandfathered like 0031): agents go live only on approved profiles.
  await recordInstalledApproval(h.db.db, { kind: 'model_profile', id: ids.profile, title: 'support-fast' }, 'Test fixture: existing profile');
  const agent = await h.http().post('/v1/agents').set(auth(tok.lead)).send({ name: 'Maya', conversationType: 'SUPPORT', modelProfileId: ids.profile, teamIds: [ids.cards] }).expect(201);
  ids.maya = agent.body.id;
});
afterAll(async () => {
  await h?.close();
});

describe('taking an agent live through the approval queue', () => {
  it('a draft agent changes directly (200)', async () => {
    const res = await h.http().patch(`/v1/agents/${ids.maya}`).set(auth(tok.lead)).send({ purpose: 'customer support' }).expect(200);
    expect(res.body.purpose).toBe('customer support');
  });

  it('going live without a checker is 409 approval_required naming the kind and action', async () => {
    const res = await h.http().post(`/v1/agents/${ids.maya}/status`).set(auth(tok.lead)).send({ status: 'LIVE' }).expect(409);
    expect(res.body.error).toMatchObject({ code: 'approval_required', details: { objectKind: 'agent', objectId: ids.maya, action: 'ACTIVATE' } });
  });

  it('lists the eligible checkers: the team’s Heads, not the Lead or the Service member', async () => {
    const res = await h.http().get('/v1/approvals/checkers').query({ objectKind: 'agent', objectId: ids.maya }).set(auth(tok.lead)).expect(200);
    expect(res.body.checkers.map((c: { name: string }) => c.name).sort()).toEqual(['Anjali Rao', 'Priya Nair']);
    expect(res.body.bootstrapAllowed).toBe(false);
  });

  it('submits (202), locks the agent, and the checker approves with the hash they saw', async () => {
    const submitted = await h
      .http()
      .post(`/v1/agents/${ids.maya}/status`)
      .set(auth(tok.lead))
      .send({ status: 'LIVE', approval: { checkerId: ids.head, reason: 'Ready for customers' } })
      .expect(202);
    const proposal = submitted.body.proposal;
    ids.golive = proposal.id;
    expect(proposal).toMatchObject({ status: 'SUBMITTED', title: 'Take Maya live', checker: { name: 'Anjali Rao' } });
    expect(proposal).not.toHaveProperty('payload');

    const locked = await h.http().patch(`/v1/agents/${ids.maya}`).set(auth(tok.lead)).send({ purpose: 'sneaky' }).expect(409);
    expect(locked.body.error.code).toBe('approval_open');
    const agent = await h.http().get(`/v1/agents/${ids.maya}`).set(auth(tok.lead)).expect(200);
    expect(agent.body.approval).toMatchObject({ approved: false, pending: { id: proposal.id, checkerName: 'Anjali Rao' } });

    const inbox = await h.http().get('/v1/approvals').query({ box: 'AWAITING_ME' }).set(auth(tok.head)).expect(200);
    expect(inbox.body.rows.map((r: { id: string }) => r.id)).toEqual([proposal.id]);
    expect((await h.http().get('/v1/approvals/counts').set(auth(tok.head)).expect(200)).body).toMatchObject({ awaitingMe: 1 });
    const detail = (await h.http().get(`/v1/approvals/${proposal.id}`).set(auth(tok.head)).expect(200)).body;
    expect(detail.canDecide).toBe(true);
    expect(detail.diff).toContainEqual({ path: 'status', before: 'DRAFT', after: 'LIVE', change: 'changed' });

    // The maker cannot approve their own change; a Lead cannot decide at all.
    await h.http().post(`/v1/approvals/${proposal.id}/decision`).set(auth(tok.lead)).send({ decision: 'APPROVE', contentHash: detail.contentHash }).expect(403);
    await h.http().post(`/v1/approvals/${proposal.id}/decision`).set(auth(tok.head2)).send({ decision: 'APPROVE', contentHash: detail.contentHash }).expect(403);

    await deliverNotices();
    expect(h.emailsTo('anjali@ocso.test').map((m) => m.subject)).toContain('[OCSO] Approval needed: Take Maya live');

    const decided = await h.http().post(`/v1/approvals/${proposal.id}/decision`).set(auth(tok.head)).send({ decision: 'APPROVE', reason: 'Checked', contentHash: detail.contentHash }).expect(200);
    expect(decided.body).toMatchObject({ status: 'APPROVED', activating: false });
    const live = await h.http().get(`/v1/agents/${ids.maya}`).set(auth(tok.lead)).expect(200);
    expect(live.body).toMatchObject({ status: 'LIVE', approval: { approved: true, pending: null, updateNeedsApproval: true } });
    await deliverNotices();
    expect(h.emailsTo('lena@ocso.test').map((m) => m.subject)).toContain('[OCSO] Approved: Take Maya live');
  });
});

describe('changing a live agent', () => {
  it('a change is 409 without a checker and 202 with one; a stale hash after an edit is 409 content_changed', async () => {
    await h.http().patch(`/v1/agents/${ids.maya}`).set(auth(tok.lead)).send({ maxToolSteps: 3 }).expect(409);
    const proposal = (await h.http().patch(`/v1/agents/${ids.maya}`).set(auth(tok.lead)).send({ maxToolSteps: 3, approval: { checkerId: ids.head2, reason: 'Fewer tool loops' } }).expect(202)).body.proposal;
    const seen = (await h.http().get(`/v1/approvals/${proposal.id}`).set(auth(tok.head2)).expect(200)).body;
    const edited = (await h.http().patch(`/v1/approvals/${proposal.id}`).set(auth(tok.lead)).send({ payload: { maxToolSteps: 2 } }).expect(200)).body;
    expect(edited).toMatchObject({ revision: 2 });
    const stale = await h.http().post(`/v1/approvals/${proposal.id}/decision`).set(auth(tok.head2)).send({ decision: 'APPROVE', contentHash: seen.contentHash }).expect(409);
    expect(stale.body.error.code).toBe('content_changed');
    await h.http().post(`/v1/approvals/${proposal.id}/decision`).set(auth(tok.head2)).send({ decision: 'REJECT', contentHash: edited.contentHash }).expect(400);
    await h.http().post(`/v1/approvals/${proposal.id}/decision`).set(auth(tok.head2)).send({ decision: 'REJECT', reason: 'Keep 3', contentHash: edited.contentHash }).expect(200);
    expect((await h.http().get(`/v1/agents/${ids.maya}`).set(auth(tok.lead)).expect(200)).body.maxToolSteps).toBe(6);
  });

  it('pausing is immediate (a stop action); resuming is a proposal', async () => {
    await h.http().post(`/v1/agents/${ids.maya}/status`).set(auth(tok.lead)).send({ status: 'PAUSED' }).expect(201);
    const resume = (await h.http().post(`/v1/agents/${ids.maya}/status`).set(auth(tok.lead)).send({ status: 'LIVE', approval: { checkerId: ids.head, reason: 'Back on' } }).expect(202)).body.proposal;
    expect(resume.title).toBe('Resume Maya');
    const reassigned = await h.http().post(`/v1/approvals/${resume.id}/checker`).set(auth(tok.admin)).send({ checkerId: ids.head2, reason: 'Anjali is out' }).expect(200);
    expect(reassigned.body.checker.name).toBe('Priya Nair');
    await h.http().post(`/v1/approvals/${resume.id}/checker`).set(auth(tok.admin)).send({ checkerId: ids.lead, reason: 'Nope' }).expect(400);
    const bulk = await h.http().post('/v1/approvals/bulk-decision').set(auth(tok.head2)).send({ decision: 'APPROVE', reason: 'Batch', items: [{ id: resume.id, contentHash: reassigned.body.contentHash }] }).expect(200);
    expect(bulk.body).toMatchObject({ approved: [resume.id], skipped: [] });
    expect((await h.http().get(`/v1/agents/${ids.maya}`).set(auth(tok.lead)).expect(200)).body.status).toBe('LIVE');
  });

  it('activating a prompt of an approved agent is a prompt_version proposal', async () => {
    const draft = (await h.http().get(`/v1/agents/${ids.maya}/prompt`).set(auth(tok.lead)).expect(200)).body;
    const components = Object.fromEntries(draft.components.filter((c: { text: string | null }) => c.text !== null).map((c: { key: string; text: string }) => [c.key, c.text]));
    await h.http().put(`/v1/agents/${ids.maya}/prompt/draft`).set(auth(tok.lead)).send({ ...components, identity: 'You are Maya, v2.' }).expect(204);
    const version = (await h.http().post(`/v1/agents/${ids.maya}/prompt/versions`).set(auth(tok.lead)).send({ reason: 'Sharper identity' }).expect(201)).body;
    const refused = await h.http().post(`/v1/agents/${ids.maya}/prompt/versions/${version.id}/activate`).set(auth(tok.lead)).expect(409);
    expect(refused.body.error.details).toMatchObject({ objectKind: 'prompt_version', action: 'ACTIVATE' });
    const proposed = await h.http().post(`/v1/agents/${ids.maya}/prompt/versions/${version.id}/activate`).set(auth(tok.lead)).send({ approval: { checkerId: ids.head, reason: 'Sharper identity' } }).expect(202);
    expect(proposed.body.proposal.title).toBe('Activate prompt v2 for Maya');
  });

  it('deleting needs agents.delete (Head) and is always a proposal', async () => {
    const temp = (await h.http().post('/v1/agents').set(auth(tok.lead)).send({ name: 'Temp', conversationType: 'SUPPORT', teamIds: [ids.cards] }).expect(201)).body.id;
    await h.http().delete(`/v1/agents/${temp}`).set(auth(tok.lead)).send({}).expect(403);
    await h.http().delete(`/v1/agents/${temp}`).set(auth(tok.head2)).send({}).expect(409);
    const proposal = (await h.http().delete(`/v1/agents/${temp}`).set(auth(tok.head2)).send({ approval: { checkerId: ids.head, reason: 'Unused test agent' } }).expect(202)).body.proposal;
    const shown = (await h.http().get(`/v1/approvals/${proposal.id}`).set(auth(tok.head)).expect(200)).body;
    await h.http().post(`/v1/approvals/${proposal.id}/decision`).set(auth(tok.head)).send({ decision: 'APPROVE', contentHash: shown.contentHash }).expect(200);
    await h.http().get(`/v1/agents/${temp}`).set(auth(tok.lead)).expect(404);
  });

  it('the maker withdraws; the Service member reads but decides nothing; kinds are listed', async () => {
    const open = (await h.http().get('/v1/approvals').query({ box: 'AWAITING_ME' }).set(auth(tok.head)).expect(200)).body.rows[0];
    const seen = (await h.http().get(`/v1/approvals/${open.id}`).set(auth(tok.service)).expect(200)).body;
    expect(seen).toMatchObject({ canDecide: false, canEdit: false });
    await h.http().post(`/v1/approvals/${open.id}/withdraw`).set(auth(tok.service)).send({ reason: 'not mine' }).expect(403);
    await h.http().post(`/v1/approvals/${open.id}/withdraw`).set(auth(tok.lead)).send({ reason: 'Later' }).expect(204);
    const kinds = (await h.http().get('/v1/approvals/kinds').set(auth(tok.service)).expect(200)).body;
    // Every registered kind (approvals/coverage.test.ts pins the reviewed list).
    expect(kinds.map((k: { kind: string }) => k.kind)).toEqual(expect.arrayContaining(['agent', 'prompt_version', 'channel', 'deployment_settings']));
    await h.http().get('/v1/approvals').query({ box: 'OPEN' }).set(auth(tok.head)).expect(403);
    await h.http().get('/v1/approvals').query({ box: 'OPEN' }).set(auth(tok.admin)).expect(200);
  });

  it('Tech (approvals.reassign_any) voids a stuck proposal over HTTP; a Head cannot; the checker list is names only for Service', async () => {
    const res = await h.http().patch(`/v1/agents/${ids.maya}`).set(auth(tok.lead)).send({ description: 'stuck', approval: { checkerId: ids.head, reason: 'Stuck one' } }).expect(202);
    const id = res.body.proposal.id as string;
    await h.http().post(`/v1/approvals/${id}/void`).set(auth(tok.head)).send({ reason: 'Not mine' }).expect(403);
    const voided = (await h.http().post(`/v1/approvals/${id}/void`).set(auth(tok.admin)).send({ reason: 'Maker away; closing' }).expect(200)).body;
    expect(voided).toMatchObject({ status: 'VOID', decisionReason: 'Maker away; closing' });
    // Service holds no make permission for agents: no candidate list at all.
    await h.http().get('/v1/approvals/checkers').query({ objectKind: 'agent', objectId: ids.maya }).set(auth(tok.service)).expect(403);
  });
});
