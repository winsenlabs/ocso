import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { channels, messageTemplates, routers, uuidv7 } from '@ocso/db';
import type { RouterDefinition } from '@ocso/domain';
import { QueueService, RouterService, isApproved, routerApproval, type QueueInput } from '../src/index.js';
import { act, createApprovalFixture, type ApprovalFixture } from './approvals/fixture.js';

/**
 * The `router` approval kind (PM/research/11 §4.4, §5; wave 2): a Lead builds a
 * language menu over two attribute queues; the router only goes live through a
 * Head's approval, only over approved queues whose agent is live; channel
 * attachment on an approved router is a proposal, detaching and disabling are
 * stops; resuming is an ACTIVATE; the approval pins the version the checker saw.
 */
let f: ApprovalFixture;
let queues: QueueService;
let service: RouterService;
const ids = { tamil: '', english: '', router: '', web: '', wa: '', arjun: '' };

const queueInput = (name: string, extra: Partial<QueueInput> = {}): QueueInput => ({
  name,
  description: null,
  mode: 'OPEN_PICKUP',
  autoAssignAfterSeconds: null,
  acceptTimeoutSeconds: 120,
  requiredSkills: [],
  languages: [],
  preferAccountOwner: true,
  slaPolicyId: null,
  teamIds: [f.team.cards],
  agentId: null,
  attributes: {},
  businessHours: null,
  transferTargetIds: [],
  ...extra,
});

const menu = (): RouterDefinition => ({
  steps: [
    {
      id: 'lang',
      kind: 'ASK',
      attribute: 'language',
      prompt: { text: 'Which language? / எந்த மொழி?' },
      options: [
        { value: 'en', label: 'English' },
        { value: 'ta', label: 'தமிழ் Tamil', synonyms: ['tamil'] },
      ],
      maxAttempts: 2,
      skipIfKnown: true,
    },
  ],
  rules: [{ when: { language: 'ta' }, queueId: ids.tamil }],
  fallbackQueueId: ids.english,
  returning: null,
  timeoutMinutes: 10,
});

const goLive = async (agentId: string) => f.approve(f.p.head, (await f.submit(f.p.lead, f.p.head, { objectKind: 'agent', objectId: agentId, action: 'ACTIVATE' })).id);
const routerRow = async () => (await f.t.db.select().from(routers).where(eq(routers.id, ids.router)))[0]!;
const channelRouter = async (id: string) => (await f.t.db.select({ routerId: channels.routerId }).from(channels).where(eq(channels.id, id)))[0]!.routerId;

beforeAll(async () => {
  f = await createApprovalFixture();
  queues = new QueueService(f.t.db);
  service = new RouterService(f.t.db);
  ids.arjun = await f.newAgent('Arjun');
  await goLive(f.maya);
  ids.tamil = await queues.create(act(f.p.lead), queueInput('Tamil', { agentId: f.maya, attributes: { language: 'ta' } }));
  ids.english = await queues.create(act(f.p.lead), queueInput('English', { agentId: ids.arjun, attributes: { language: 'en' } }));
  [ids.web, ids.wa] = [uuidv7(), uuidv7()];
  await f.t.db.insert(channels).values([
    { id: ids.web, kind: 'WEBCHAT', name: 'Web chat', status: 'ACTIVE', publicKey: `pk-${ids.web}` },
    { id: ids.wa, kind: 'WHATSAPP', name: 'WhatsApp', status: 'ACTIVE', publicKey: `pk-${ids.wa}` },
  ]);
});
afterAll(async () => {
  await f?.t.drop();
});

describe('a draft router', () => {
  it('is written directly: definition, name, channels (it routes nothing until approved)', async () => {
    const created = await service.create(act(f.p.lead), { name: 'Language menu', description: '', definition: menu() });
    ids.router = created.id;
    await service.saveDraft(act(f.p.lead), ids.router, { definition: menu(), name: 'Language menu (web)' });
    await service.attachDirect(act(f.p.lead), ids.router, [ids.web]);
    expect(await channelRouter(ids.web)).toBe(ids.router);
    await service.freezeVersion(act(f.p.lead), ids.router, 'first');
    expect((await routerRow()).status).toBe('DRAFT');
  });

  it('cannot be proposed over queues nobody has approved (hard), but may be while their approval is open (soft)', async () => {
    await expect(f.submit(f.p.lead, f.p.head, { objectKind: 'router', objectId: ids.router, action: 'ACTIVATE' })).rejects.toMatchObject({
      code: 'validation_failed',
      details: { problems: expect.arrayContaining([expect.objectContaining({ code: 'queue_not_approved' }), expect.objectContaining({ code: 'queue_agent_not_live' })]) },
    });
    for (const q of [ids.tamil, ids.english]) await f.submit(f.p.lead, f.p.head, { objectKind: 'queue', objectId: q, action: 'CREATE' });
    // Arjun's go-live is also still open: a soft problem.
    await f.submit(f.p.lead, f.p.head, { objectKind: 'agent', objectId: ids.arjun, action: 'ACTIVATE' });
    const proposal = await f.submit(f.p.lead, f.p.head, { objectKind: 'router', objectId: ids.router, action: 'ACTIVATE' });
    expect(proposal).toMatchObject({ title: 'Activate router Language menu (web) v1', status: 'SUBMITTED' });
    expect(proposal.after).toMatchObject({ status: 'ACTIVE', version: 'v1', rules: ['1. language=ta → Tamil'], fallbackQueue: 'English', channels: ['Web chat'] });
    // Approving it before its queues are approved blocks: the router stays a draft.
    expect(await f.approve(f.p.head, proposal.id)).toMatchObject({ status: 'BLOCKED' });
    expect((await routerRow()).status).toBe('DRAFT');
  });

  it('goes live through a Head once its queues are approved and their agents live', async () => {
    const open = await f.approvals.list(f.p.head, { box: 'AWAITING_ME', limit: 50 });
    for (const row of open.rows) await f.approve(f.p.head, row.id);
    expect(await isApproved(f.t.db, 'queue', ids.tamil)).toBe(true);
    const proposal = await f.submit(f.p.lead, f.p.head2, { objectKind: 'router', objectId: ids.router, action: 'ACTIVATE' });
    expect(await f.approve(f.p.head2, proposal.id)).toMatchObject({ status: 'APPROVED' });
    expect(await routerRow()).toMatchObject({ status: 'ACTIVE' });
    expect(await routerApproval.liveObjects(f.t.db)).toContain(ids.router);
  });
});

describe('an approved router', () => {
  it('attaching a channel is a proposal; detaching is a stop that an open proposal does not lock', async () => {
    await expect(service.attachDirect(act(f.p.lead), ids.router, [ids.wa])).rejects.toMatchObject({ code: 'approval_required', details: { objectKind: 'router', action: 'UPDATE' } });
    const proposal = await f.submit(f.p.lead, f.p.head, { objectKind: 'router', objectId: ids.router, action: 'UPDATE', payload: { attachChannelIds: [ids.wa] } });
    expect(proposal.diff).toContainEqual(expect.objectContaining({ path: 'channels', change: 'changed' }));
    const { detached } = await service.detachExcept(act(f.p.lead), ids.router, []);
    expect(detached).toEqual([ids.web]);
    await f.approve(f.p.head, proposal.id);
    // The approval adds what it proposed; the stop taken meanwhile stays.
    expect(await channelRouter(ids.wa)).toBe(ids.router);
    expect(await channelRouter(ids.web)).toBeNull();
  });

  it('renaming is a proposal; editing the (inert) draft definition is not', async () => {
    await expect(service.saveDraft(act(f.p.lead), ids.router, { definition: menu(), name: 'Renamed' })).rejects.toMatchObject({ code: 'approval_required' });
    await service.saveDraft(act(f.p.lead), ids.router, { definition: { ...menu(), timeoutMinutes: 5 } });
  });

  it('the approval pins the version the checker saw: freezing another voids it', async () => {
    await service.freezeVersion(act(f.p.lead), ids.router, 'shorter timeout');
    const proposal = await f.submit(f.p.lead, f.p.head, { objectKind: 'router', objectId: ids.router, action: 'ACTIVATE' });
    await service.freezeVersion(act(f.p.lead), ids.router, 'sneaky');
    const shown = proposal;
    await expect(f.decisions.decide(act(f.p.head), proposal.id, { decision: 'APPROVE', reason: 'ok', contentHash: shown.contentHash })).rejects.toMatchObject({ code: 'content_changed' });
    await f.decisions.decide(act(f.p.head), proposal.id, { decision: 'REJECT', reason: 'stale', contentHash: shown.contentHash });
  });

  it('disable is immediate; resuming is an ACTIVATE of the newest version', async () => {
    await service.disable(act(f.p.lead), ids.router);
    expect((await routerRow()).status).toBe('DISABLED');
    const resume = await f.submit(f.p.lead, f.p.head, { objectKind: 'router', objectId: ids.router, action: 'ACTIVATE' });
    expect(resume.title).toBe('Resume router Language menu (web) (v3)');
    await f.approve(f.p.head, resume.id);
    expect(await routerRow()).toMatchObject({ status: 'ACTIVE' });
  });

  it('refuses queues whose agent is not live', async () => {
    const paused = await queues.create(act(f.p.lead), queueInput('Paused agent', { agentId: f.maya }));
    await f.approve(f.p.head, (await f.submit(f.p.lead, f.p.head, { objectKind: 'queue', objectId: paused, action: 'CREATE' })).id);
    await f.agents.setStatus(act(f.p.lead), f.maya, 'PAUSED');
    await service.saveDraft(act(f.p.lead), ids.router, { definition: { ...menu(), fallbackQueueId: paused } });
    await service.freezeVersion(act(f.p.lead), ids.router, 'paused fallback');
    await expect(f.submit(f.p.lead, f.p.head, { objectKind: 'router', objectId: ids.router, action: 'ACTIVATE' })).rejects.toMatchObject({
      details: { problems: expect.arrayContaining([expect.objectContaining({ code: 'queue_agent_not_live' })]) },
    });
  });

  it('approving an activation after someone disabled the router does not undo the stop', async () => {
    await goLive(f.maya); // resuming the agent the previous test paused
    await service.saveDraft(act(f.p.lead), ids.router, { definition: menu() });
    await service.freezeVersion(act(f.p.lead), ids.router, 'back to the menu');
    const proposal = await f.submit(f.p.lead, f.p.head, { objectKind: 'router', objectId: ids.router, action: 'ACTIVATE' });
    expect(proposal.title).toContain('Activate router');
    // An incident: the router is stopped while the proposal waits.
    await service.disable(act(f.p.lead), ids.router);
    const decided = await f.approve(f.p.head, proposal.id);
    expect(decided).toMatchObject({ status: 'BLOCKED', blockedReason: expect.stringContaining('was disabled after this was proposed') });
    expect((await routerRow()).status).toBe('DISABLED');
    // Resuming is its own proposal, titled as such.
    const resume = await f.submit(f.p.lead, f.p.head, { objectKind: 'router', objectId: ids.router, action: 'ACTIVATE' });
    expect(resume.title).toMatch(/^Resume router/);
    await f.approve(f.p.head, resume.id);
    expect((await routerRow()).status).toBe('ACTIVE');
  });

  it('a live router is changed, stopped and proposed on only by the teams it serves', async () => {
    const outsider = act(f.p.headLoans);
    await expect(service.disable(outsider, ids.router)).rejects.toMatchObject({ category: 'authorization' });
    await expect(service.freezeVersion(outsider, ids.router, 'take over')).rejects.toMatchObject({ category: 'authorization' });
    await expect(service.detachExcept(outsider, ids.router, [])).rejects.toMatchObject({ category: 'authorization' });
    await expect(f.approvals.submit(outsider, { objectKind: 'router', objectId: ids.router, action: 'ACTIVATE', checkerId: f.p.head.userId, reason: 'take over' })).rejects.toMatchObject({ category: 'authorization' });
    // Its proposals are checked by the teams its live version serves, and show whose customers they are.
    expect(await routerApproval.teamIds(f.t.db, ids.router)).toEqual([f.team.cards]);
    expect(await routerApproval.project(f.t.db, ids.router)).toMatchObject({ servedTeams: ['Cards'] });
  });

  it('another router’s channel is never taken: it is detached there first', async () => {
    const other = await service.create(act(f.p.headLoans), { name: 'Loans menu', description: '', definition: menu() });
    await expect(service.attachDirect(act(f.p.headLoans), other.id, [ids.wa])).rejects.toMatchObject({ code: 'channel_on_other_router' });
    expect(await channelRouter(ids.wa)).toBe(ids.router);
    await service.attachDirect(act(f.p.headLoans), other.id, [ids.web]);
    await expect(f.submit(f.p.lead, f.p.head, { objectKind: 'router', objectId: ids.router, action: 'UPDATE', payload: { attachChannelIds: [ids.web] } })).rejects.toMatchObject({
      details: { problems: [expect.objectContaining({ code: 'channel_on_other_router' })] },
    });
    await service.detachExcept(act(f.p.headLoans), other.id, []);
  });

  it('delete is a proposal, refused while channels are attached; approved once they are detached', async () => {
    await expect(f.submit(f.p.lead, f.p.head, { objectKind: 'router', objectId: ids.router, action: 'DELETE' })).rejects.toMatchObject({
      details: { problems: [expect.objectContaining({ code: 'router_has_channels' })] },
    });
    await service.detachExcept(act(f.p.lead), ids.router, []);
    const proposal = await f.submit(f.p.lead, f.p.head, { objectKind: 'router', objectId: ids.router, action: 'DELETE' });
    expect(proposal.title).toBe('Delete router Language menu (web)');
    await f.approve(f.p.head, proposal.id);
    expect(await f.t.db.select().from(routers).where(eq(routers.id, ids.router))).toEqual([]);
  });

  it('a router nobody can read is not found; Service members never propose', async () => {
    const other = await service.create(act(f.p.lead), { name: 'Other', description: '', definition: menu() });
    await expect(f.approvals.submit(act(f.p.service), { objectKind: 'router', objectId: other.id, action: 'ACTIVATE', checkerId: f.p.head.userId, reason: 'try' })).rejects.toMatchObject({ category: 'authorization' });
    await expect(routerApproval.assertVisible(f.t.db, f.p.service, other.id)).rejects.toMatchObject({ category: 'not_found' });
  });
});

describe('a router message’s per-channel template (the builder’s “Create template for <channel>”)', () => {
  it('the drafted template’s record id maps into the message; activation needs it approved and on that channel', async () => {
    const templateId = uuidv7();
    // What POST /v1/channels/:id/templates drafts: its `submission.recordId` is this row's id.
    await f.t.db.insert(messageTemplates).values({ id: templateId, channelId: ids.wa, name: 'language_menu', language: 'en', category: 'UTILITY', status: 'DRAFT', definition: { body: 'Which language?' } });
    const def = menu();
    const step = def.steps[0]!;
    if (step.kind !== 'ASK') throw new Error('menu starts with ASK');
    step.prompt = { ...step.prompt, templates: { [ids.wa]: templateId } };
    const templated = await service.create(act(f.p.lead), { name: 'Templated menu', description: '', definition: def });
    await service.freezeVersion(act(f.p.lead), templated.id, 'with template');
    await expect(f.submit(f.p.lead, f.p.head, { objectKind: 'router', objectId: templated.id, action: 'ACTIVATE' })).rejects.toMatchObject({
      details: { problems: expect.arrayContaining([expect.objectContaining({ code: 'template_not_approved' })]) },
    });
    // The provider approved it (the template's own approval, then the provider's review).
    await f.t.db.update(messageTemplates).set({ status: 'APPROVED', providerTemplateId: 'HX0f0e72ce92eef937d6f481b338ecbd19' }).where(eq(messageTemplates.id, templateId));
    const proposal = await f.submit(f.p.lead, f.p.head, { objectKind: 'router', objectId: templated.id, action: 'ACTIVATE' });
    expect(proposal.after).toMatchObject({ templates: 1 });
    expect(proposal.problems ?? []).toEqual([]);
  });
});
