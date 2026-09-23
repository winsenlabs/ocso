import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { channels, queues, routerVersions, routers, uuidv7 } from '@ocso/db';
import type { RouterDefinition } from '@ocso/domain';
import { RouterService, activateRouterVersion, attachRouterChannels } from '../src/index.js';
import { createRoutingFixture, type RoutingFixture } from './support/routing-fixture.js';

/**
 * Router CRUD (PM/research/11 §5.7): the draft is freely editable, versions
 * are immutable, activation is an approval of the newest version
 * (router-approvals.int.test.ts covers the proposals), the simulator is a dry run.
 */
let f: RoutingFixture;
let service: RouterService;
let menu: RouterDefinition;

beforeAll(async () => {
  f = await createRoutingFixture();
  service = new RouterService(f.t.db, async (r) => ({ label: r.transcript.some((m) => /loan/i.test(m.text)) ? 'sales' : null, confidence: 0.9, followUp: null }));
  menu = {
    steps: [
      { id: 'product', kind: 'ASK', attribute: 'product', prompt: { text: 'Which one?' }, options: [{ value: 'cards', label: 'Cards' }, { value: 'sales', label: 'Loans' }], maxAttempts: 1, skipIfKnown: true },
    ],
    rules: [{ when: { product: 'sales' }, queueId: f.queues.sales }],
    fallbackQueueId: f.queues.cards,
    returning: null,
    timeoutMinutes: 10,
  };
});
afterAll(async () => {
  await f?.drop();
});

describe('router service', () => {
  it('creates a DRAFT router whose draft is editable and frozen into immutable versions', async () => {
    const created = await service.create(f.actor, { name: 'Web menu', description: 'menu', definition: menu });
    expect(created).toMatchObject({ status: 'DRAFT', kind: null, activeVersion: null, draft: { definition: menu, problems: [] }, versions: [] });
    const edited = await service.saveDraft(f.actor, created.id, { definition: { ...menu, timeoutMinutes: 5 }, name: 'Web menu v2' });
    expect(edited).toMatchObject({ name: 'Web menu v2', draft: { definition: { timeoutMinutes: 5 } } });
    expect(await service.freezeVersion(f.actor, created.id, 'first')).toMatchObject({ version: 1 });
    expect(await service.freezeVersion(f.actor, created.id, 'second')).toMatchObject({ version: 2 });
    const [v1] = await f.t.db.select().from(routerVersions).where(eq(routerVersions.routerId, created.id));
    await expect(f.t.db.update(routerVersions).set({ reason: 'changed' }).where(eq(routerVersions.id, v1!.id))).rejects.toMatchObject({ cause: { message: expect.stringContaining('immutable') } });
  });

  it('rejects invalid definitions: duplicate options, bad attribute keys, too few options', async () => {
    const bad = { ...menu, steps: [{ ...menu.steps[0]!, attribute: 'Product', options: [{ value: 'a', label: 'A' }] }] } as unknown as RouterDefinition;
    const { RouterDraftInput } = await import('../src/index.js');
    const parsed = RouterDraftInput.safeParse({ definition: bad });
    expect(parsed.success).toBe(false);
    const dup = RouterDraftInput.safeParse({ definition: { ...menu, steps: [{ ...menu.steps[0]!, options: [{ value: 'a', label: 'A' }, { value: 'A', label: 'B' }] }] } });
    expect(dup.error?.issues.map((i) => i.message)).toContain('option values must be unique within a step');
  });

  it('only the newest version can be proposed for activation (the approval pins it)', async () => {
    const created = await service.create(f.actor, { name: 'Needs approval', description: '', definition: menu });
    const v1 = await service.freezeVersion(f.actor, created.id, '');
    await expect(service.assertActivatable(f.lead, created.id, v1.id)).resolves.toBeUndefined();
    const v2 = await service.freezeVersion(f.actor, created.id, '');
    await expect(service.assertActivatable(f.lead, created.id, v1.id)).rejects.toMatchObject({ code: 'version_not_latest' });
    await expect(service.assertActivatable(f.lead, created.id, v2.id)).resolves.toBeUndefined();
    await expect(service.assertActivatable(f.lead, created.id, uuidv7())).rejects.toMatchObject({ category: 'not_found' });
  });

  it('activateVersion re-validates (a queue without its agent) and makes the router ACTIVE; attachChannels moves channels', async () => {
    const orphanQueue = uuidv7();
    await f.t.db.insert(queues).values({ id: orphanQueue, name: 'No agent yet' });
    const created = await service.create(f.actor, { name: 'Activation', description: '', definition: { ...menu, fallbackQueueId: orphanQueue } });
    expect((await service.get(f.lead, created.id)).draft?.problems).toEqual([{ code: 'queue_without_agent', message: 'Queue No agent yet has no AI agent: give it one before routing to it' }]);
    const bad = await service.freezeVersion(f.actor, created.id, '');
    await expect(f.t.db.transaction((tx) => activateRouterVersion(tx, f.actor, bad.id))).rejects.toMatchObject({ code: 'router_invalid' });

    await service.saveDraft(f.actor, created.id, { definition: menu });
    const good = await service.freezeVersion(f.actor, created.id, '');
    await f.t.db.transaction((tx) => RouterService.activateVersion(tx, f.actor, good.id));
    const [a, b] = [uuidv7(), uuidv7()];
    await f.t.db.insert(channels).values([
      { id: a, kind: 'WHATSAPP', name: 'A', status: 'ACTIVE', publicKey: 'pk-act-a' },
      { id: b, kind: 'WHATSAPP', name: 'B', status: 'ACTIVE', publicKey: 'pk-act-b' },
    ]);
    await f.t.db.transaction((tx) => attachRouterChannels(tx, f.actor, created.id, [a, b]));
    let detail = await service.get(f.lead, created.id);
    expect(detail).toMatchObject({ status: 'ACTIVE', kind: 'MENU', activeVersion: { id: good.id }, activeDefinition: menu });
    expect(detail.channels.map((c) => c.name)).toEqual(['A', 'B']);
    // Exactly these channels: B is released (routes nowhere until another router takes it).
    await f.t.db.transaction((tx) => attachRouterChannels(tx, f.actor, created.id, [a]));
    detail = await service.get(f.lead, created.id);
    expect(detail.channels.map((c) => c.name)).toEqual(['A']);
    const [released] = await f.t.db.select({ routerId: channels.routerId }).from(channels).where(eq(channels.id, b));
    expect(released?.routerId).toBeNull();

    await service.disable(f.actor, created.id);
    const [row] = await f.t.db.select({ status: routers.status }).from(routers).where(eq(routers.id, created.id));
    expect(row?.status).toBe('DISABLED');
  });

  it('simulates the draft: asks, matches replies, decides — or uses the model and pinned answers', async () => {
    const created = await service.create(f.actor, { name: 'Simulated', description: '', definition: menu });
    const asked = await service.simulate(f.lead, created.id, { messages: ['hi', '2'], answers: {}, returning: false, customer: { attributes: {} } });
    expect(asked.trace).toEqual([
      { kind: 'customer', text: 'hi' },
      { kind: 'router', stepId: 'product', text: 'Which one?', options: [{ id: 'ocso:product:cards', label: 'Cards' }, { id: 'ocso:product:sales', label: 'Loans' }] },
      { kind: 'customer', text: '2' },
      { kind: 'decided', queueId: f.queues.sales, queueName: 'Sales', agentName: 'Arjun', outcome: 'RULE', ruleIndex: 0, reason: 'rule 1: product=sales' },
    ]);
    const waiting = await service.simulate(f.lead, created.id, { messages: ['hi'], answers: {}, returning: false, customer: { attributes: {} } });
    expect(waiting.decision).toBeNull();
    expect(waiting.trace.at(-1)).toMatchObject({ kind: 'waiting' });

    const classify: RouterDefinition = {
      ...menu,
      steps: [{ id: 'intent', kind: 'CLASSIFY', attribute: 'product', modelProfileId: menu.fallbackQueueId, instructions: '', labels: [{ value: 'cards', description: '' }, { value: 'sales', description: '' }], minConfidence: 0.5, maxFollowUps: 0, skipIfKnown: false }],
    };
    const model = await service.create(f.actor, { name: 'Simulated model', description: '', definition: classify });
    expect((await service.simulate(f.lead, model.id, { messages: ['I need a loan'], answers: {}, returning: false, customer: { attributes: {} } })).decision).toMatchObject({ outcome: 'MODEL', queueName: 'Sales' });
    expect((await service.simulate(f.lead, model.id, { messages: ['I need a loan'], answers: { intent: 'cards' }, returning: false, customer: { attributes: {} } })).trace[1]).toMatchObject({ kind: 'classified', label: 'cards', source: 'answer' });
  });
});
