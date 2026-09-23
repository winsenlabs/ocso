import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { queueTeams, queues as queuesTable, slaPolicies, uuidv7, virtualAgents } from '@ocso/db';
import { passThroughDefinition } from '@ocso/domain';
import { QueueService, createActiveRouter, isApproved, queueApproval, slaPolicyApproval, systemActor, type QueueInput } from '../src/index.js';
import { act, createApprovalFixture, type ApprovalFixture } from './approvals/fixture.js';

/**
 * The `queue` and `sla_policy` approval kinds (PM/research/11 §4.4, §5.5;
 * wave 2): drafts change directly and are inert; CREATE is the first
 * approval; afterwards every change is a proposal carrying a delta, while
 * unlinking your team and removing transfer targets are stops.
 */
let f: ApprovalFixture;
let service: QueueService;
const ids = { cards: '', loans: '', policy: '' };

const input = (name: string, extra: Partial<QueueInput> = {}): QueueInput => ({
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
const row = async (id: string) => (await f.t.db.select().from(queuesTable).where(eq(queuesTable.id, id)))[0]!;
const approveCreate = async (kind: string, id: string) => f.approve(f.p.head, (await f.submit(f.p.lead, f.p.head, { objectKind: kind, objectId: id, action: 'CREATE' })).id);

beforeAll(async () => {
  f = await createApprovalFixture();
  service = new QueueService(f.t.db);
  ids.policy = await service.saveSlaPolicy(act(f.p.lead), null, { name: 'Standard', firstHumanResponseSeconds: 900, pickupSecondsByPriority: {}, resolutionSecondsByType: {}, atRiskFraction: 0.75 });
  ids.cards = await service.create(act(f.p.lead), input('Cards', { agentId: f.maya, attributes: { product: 'cards' }, slaPolicyId: ids.policy }));
  ids.loans = await service.create(act(f.p.lead), input('Loans'));
});
afterAll(async () => {
  await f?.t.drop();
});

describe('SLA policies', () => {
  it('a draft changes directly; its first approval is CREATE; afterwards a change is an UPDATE proposal', async () => {
    await service.saveSlaPolicy(act(f.p.lead), ids.policy, { name: 'Standard', firstHumanResponseSeconds: 600, pickupSecondsByPriority: {}, resolutionSecondsByType: {}, atRiskFraction: 0.75 });
    // A queue cannot be approved while its SLA policy is not.
    await expect(f.submit(f.p.lead, f.p.head, { objectKind: 'queue', objectId: ids.cards, action: 'CREATE' })).rejects.toMatchObject({ details: { problems: [expect.objectContaining({ code: 'sla_policy_not_approved' })] } });
    const created = await approveCreate('sla_policy', ids.policy);
    expect(created).toMatchObject({ status: 'APPROVED', title: 'Approve SLA policy Standard' });
    const change = { name: 'Standard', firstHumanResponseSeconds: 300, pickupSecondsByPriority: { P1: 120 }, resolutionSecondsByType: {}, atRiskFraction: 0.8 };
    await expect(service.saveSlaPolicy(act(f.p.lead), ids.policy, change)).rejects.toMatchObject({ code: 'approval_required', details: { objectKind: 'sla_policy' } });
    const proposal = await f.submit(f.p.lead, f.p.head, { objectKind: 'sla_policy', objectId: ids.policy, action: 'UPDATE', payload: change });
    expect(proposal.title).toContain('Change SLA policy Standard');
    await f.approve(f.p.head, proposal.id);
    expect((await f.t.db.select().from(slaPolicies).where(eq(slaPolicies.id, ids.policy)))[0]).toMatchObject({ firstHumanResponseSeconds: 300, atRiskFraction: 0.8 });
  });
});

describe('queues', () => {
  it('a draft queue changes directly and is not live', async () => {
    await service.update(act(f.p.lead), ids.loans, { agentId: f.maya, businessHours: { timezone: 'Asia/Kolkata', humanHours: { mon: ['09:00', '18:00'] } } });
    expect(await row(ids.loans)).toMatchObject({ agentId: f.maya });
    expect(await queueApproval.liveObjects(f.t.db)).not.toContain(ids.loans);
  });

  it('CREATE approves the draft as it is; afterwards every change is a proposal', async () => {
    const approved = await approveCreate('queue', ids.cards);
    expect(approved).toMatchObject({ status: 'APPROVED', title: 'Approve queue Cards' });
    expect(await isApproved(f.t.db, 'queue', ids.cards)).toBe(true);
    await expect(service.update(act(f.p.lead), ids.cards, { acceptTimeoutSeconds: 60 })).rejects.toMatchObject({ code: 'approval_required', details: { objectKind: 'queue', action: 'UPDATE' } });
    // An unchanged field (jsonb reorders keys) is not a change.
    await service.update(act(f.p.lead), ids.cards, { attributes: { product: 'CARDS' } });
  });

  it('transfer targets must be approved; the proposal is a delta that a stop taken meanwhile is not undone by', async () => {
    const plan = await service.planUpdate(f.p.lead, ids.cards, { transferTargetIds: [ids.loans], acceptTimeoutSeconds: 60 });
    expect(plan).toEqual({ stops: { removeTeamIds: [], removeTransferTargetIds: [] }, change: { acceptTimeoutSeconds: 60, addTransferTargetIds: [ids.loans] } });
    await expect(f.submit(f.p.lead, f.p.head, { objectKind: 'queue', objectId: ids.cards, action: 'UPDATE', payload: plan.change })).rejects.toMatchObject({
      details: { problems: [expect.objectContaining({ code: 'queue_not_approved' })] },
    });
    await approveCreate('queue', ids.loans);
    const proposal = await f.submit(f.p.lead, f.p.head, { objectKind: 'queue', objectId: ids.cards, action: 'UPDATE', payload: plan.change });
    expect(proposal.diff.map((d) => d.path)).toEqual(expect.arrayContaining(['acceptTimeoutSeconds', 'transferTargets']));
    // While it is open the queue is locked for approvable writes, never for stops.
    await expect(service.applyChange(act(f.p.lead), ids.cards, { languages: ['ta'] })).rejects.toMatchObject({ code: 'approval_open' });
    await service.applyStops(act(f.p.lead), ids.cards, { removeTeamIds: [f.team.cards], removeTransferTargetIds: [] });
    await f.approve(f.p.head, proposal.id);
    expect(await row(ids.cards)).toMatchObject({ acceptTimeoutSeconds: 60, transferTargetIds: [ids.loans] });
    expect(await f.t.db.select().from(queueTeams).where(eq(queueTeams.queueId, ids.cards))).toEqual([]);
  });

  it('removing a transfer target is a stop', async () => {
    await service.update(act(f.p.lead), ids.cards, { transferTargetIds: [] });
    expect((await row(ids.cards)).transferTargetIds).toEqual([]);
  });

  it('names only agents the maker’s teams own, even through the generic submit', async () => {
    const agentId = (await f.agents.create(act(f.p.headLoans), { name: 'Kiran', purpose: 'x', conversationType: 'COLLECTIONS', description: '', teamIds: [f.team.loans] })).id;
    await expect(service.planUpdate(f.p.lead, ids.loans, { agentId })).rejects.toMatchObject({ category: 'not_found' });
    await expect(f.submit(f.p.lead, f.p.head, { objectKind: 'queue', objectId: ids.loans, action: 'UPDATE', payload: { agentId } })).rejects.toMatchObject({
      details: { problems: [expect.objectContaining({ code: 'agent_not_yours' })] },
    });
  });

  it('a queue live routing reaches changes only through approval; removing its agent is refused', async () => {
    await createActiveRouter(f.t.db, systemActor('test', 'routing'), { name: 'Pass', definition: passThroughDefinition(ids.loans), channelIds: [] });
    expect(await queueApproval.liveObjects(f.t.db)).toEqual(expect.arrayContaining([ids.loans]));
    expect(await slaPolicyApproval.liveObjects(f.t.db)).toEqual([]);
    await expect(f.submit(f.p.lead, f.p.head, { objectKind: 'queue', objectId: ids.loans, action: 'UPDATE', payload: { agentId: null } })).rejects.toMatchObject({
      details: { problems: [expect.objectContaining({ code: 'queue_routed' })] },
    });
    // The SLA policy of a live queue is live too.
    await f.approve(f.p.head, (await f.submit(f.p.lead, f.p.head, { objectKind: 'queue', objectId: ids.loans, action: 'UPDATE', payload: { slaPolicyId: ids.policy } })).id);
    expect(await slaPolicyApproval.liveObjects(f.t.db)).toEqual([ids.policy]);
  });
});

describe('what "live" means, and edits that must not undo anyone else’s', () => {
  it('a queue nobody approved that an active router reaches is gated: a direct change answers approval_required', async () => {
    const tamil = await service.create(act(f.p.lead), input('Tamil', { agentId: f.maya, attributes: { language: 'ta' } }));
    expect(await isApproved(f.t.db, 'queue', tamil)).toBe(false);
    await createActiveRouter(f.t.db, systemActor('test', 'routing'), { name: 'Tamil pass', definition: passThroughDefinition(tamil), channelIds: [] });
    await expect(service.update(act(f.p.lead), tamil, { acceptTimeoutSeconds: 60 })).rejects.toMatchObject({ code: 'approval_required', details: { objectKind: 'queue', objectId: tamil } });
  });

  it('so is a draft queue that is a live agent’s default queue (it takes that agent’s handoffs)', async () => {
    const fallback = await service.create(act(f.p.lead), input('Fallback desk'));
    await service.update(act(f.p.lead), fallback, { languages: ['en'] });
    const nila = await f.newAgent('Nila');
    await f.t.db.update(virtualAgents).set({ status: 'LIVE', defaultQueueId: fallback }).where(eq(virtualAgents.id, nila));
    expect(await queueApproval.liveObjects(f.t.db)).toContain(fallback);
    await expect(service.update(act(f.p.lead), fallback, { languages: ['hi'] })).rejects.toMatchObject({ code: 'approval_required' });
  });

  it('a live queue’s new agent must be live', async () => {
    const draftAgent = await f.newAgent('Tara');
    await expect(f.submit(f.p.lead, f.p.head, { objectKind: 'queue', objectId: ids.loans, action: 'UPDATE', payload: { agentId: draftAgent } })).rejects.toMatchObject({
      details: { problems: [expect.objectContaining({ code: 'queue_agent_not_live' })] },
    });
  });

  it('added teams must exist', async () => {
    await expect(f.submit(f.p.lead, f.p.head, { objectKind: 'queue', objectId: ids.loans, action: 'UPDATE', payload: { addTeamIds: [uuidv7()], languages: ['kn'] } })).rejects.toMatchObject({
      details: { problems: [expect.objectContaining({ code: 'team_not_found' })] },
    });
  });

  it('a stale form removes only what its editor saw and unticked', async () => {
    const desk = await service.create(act(f.p.lead), input('Desk'));
    const baseline = { teamIds: [f.team.cards], transferTargetIds: [] as string[] };
    // Meanwhile someone adds a transfer target and another team links itself.
    await service.update(act(f.p.lead), desk, { transferTargetIds: [ids.cards] });
    await f.t.db.insert(queueTeams).values({ queueId: desk, teamId: f.team.loans });
    // The stale form (no target, only Cards) saves a rename: nothing it never saw is removed.
    const plan = await service.planUpdate(f.p.lead, desk, { name: 'Front desk', teamIds: [f.team.cards], transferTargetIds: [] }, baseline);
    expect(plan).toEqual({ stops: { removeTeamIds: [], removeTransferTargetIds: [] }, change: { name: 'Front desk' } });
    // Unticking what it did see is still a stop.
    expect((await service.planUpdate(f.p.lead, desk, { transferTargetIds: [] }, { transferTargetIds: [ids.cards] })).stops.removeTransferTargetIds).toEqual([ids.cards]);
    // Without a baseline the lists replace the current ones (API clients): Loans is not the Lead’s to unlink.
    await expect(service.planUpdate(f.p.lead, desk, { teamIds: [f.team.cards] })).rejects.toMatchObject({ code: 'queue_team_not_yours' });
  });

  it('unlinking the last team of a live queue is refused (its handoffs would have nobody)', async () => {
    expect((await f.t.db.select().from(queueTeams).where(eq(queueTeams.queueId, ids.loans))).map((r) => r.teamId)).toEqual([f.team.cards]);
    await expect(service.update(act(f.p.lead), ids.loans, { teamIds: [] })).rejects.toMatchObject({ code: 'queue_last_team' });
  });
});
