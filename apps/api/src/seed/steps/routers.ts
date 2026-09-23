import { desc, eq } from 'drizzle-orm';
import { RouterService, approvalGates, recordAudit, type ActorContext } from '@ocso/application';
import { passThroughDefinition } from '@ocso/domain';
import { channels, queues, routerVersions, routers, slaPolicies } from '@ocso/db';
import type { SeedContext } from '../context.js';
import type { AgentKey } from '../data/agents.js';
import type { LeadKey, QueueKey } from '../data/organization.js';

/** Each demo queue's AI agent and attributes (PM/research/11 §5.5): the service unit. */
const SERVICE: ReadonlyArray<{ queue: QueueKey; agent: AgentKey; attributes: Record<string, string>; transferTo: QueueKey[] }> = [
  { queue: 'cardsT2', agent: 'maya', attributes: { product: 'cards' }, transferTo: ['salesCallback'] },
  { queue: 'salesCallback', agent: 'arjun', attributes: { product: 'sales' }, transferTo: ['cardsT2'] },
  { queue: 'hardship', agent: 'riya', attributes: { product: 'collections' }, transferTo: [] },
];

export const WEBCHAT_ROUTER = 'Meridian web chat';
export const EXAMPLE_MENU_ROUTER = 'Meridian menu (example)';

/**
 * Routing for the demo: draft queues get their agent, attributes and transfer
 * targets; the web chat is attached to a draft pass-through router to Maya
 * (activated through an approval by approveRouting once Maya is live); and a
 * menu router is left as an editable draft to show the builder.
 */
export async function seedRouters(ctx: SeedContext, admin: ActorContext, lead: ActorContext, agents: Record<AgentKey, string>, queueIds: Record<QueueKey, string>, webchatChannelId: string): Promise<void> {
  for (const s of SERVICE) {
    const [row] = await ctx.db.select({ agentId: queues.agentId }).from(queues).where(eq(queues.id, queueIds[s.queue]));
    if (row?.agentId) continue;
    // Never behind a checker's back: a queue with any approval (or one open) changes only through proposals.
    if ((await approvalGates(ctx.db, 'queue', [queueIds[s.queue]])).get(queueIds[s.queue]) !== 'none') continue;
    // Seeds are the trusted setup path (like the pass-through router below): the values an approved queue change
    // would apply, written directly — the demo's queues span teams no one lead belongs to (queue writes are team-scoped).
    const values = { agentId: agents[s.agent], attributes: s.attributes, transferTargetIds: s.transferTo.map((q) => queueIds[q]) };
    await ctx.db.transaction(async (tx) => {
      await tx.update(queues).set({ ...values, updatedAt: new Date() }).where(eq(queues.id, queueIds[s.queue]));
      await recordAudit(tx, admin, { action: 'queue.update', targetType: 'queue', targetId: queueIds[s.queue], summary: `Demo seed: queue ${s.queue} is served by ${s.agent}`, after: values });
    });
    ctx.log(`queue ${s.queue} is served by ${s.agent}`);
  }
  const [channel] = await ctx.db.select({ routerId: channels.routerId }).from(channels).where(eq(channels.id, webchatChannelId));
  if (channel && !channel.routerId) {
    // A draft attached to the web chat; it goes live through its approval once Maya is live (approveRouting).
    const service = new RouterService(ctx.db);
    const created = await service.create(lead, { name: WEBCHAT_ROUTER, description: 'Every web chat customer goes to Maya', definition: passThroughDefinition(queueIds.cardsT2) });
    await service.attachDirect(lead, created.id, [webchatChannelId]);
    await service.freezeVersion(lead, created.id, 'Demo seed: pass-through to Maya');
    ctx.log(`web chat attached to draft router "${WEBCHAT_ROUTER}" (pass-through to Maya)`);
  }
  void admin;
  const [example] = await ctx.db.select({ id: routers.id }).from(routers).where(eq(routers.name, EXAMPLE_MENU_ROUTER));
  if (!example) {
    await new RouterService(ctx.db).create(lead, {
      name: EXAMPLE_MENU_ROUTER,
      description: 'A menu that asks what the customer needs; attach it to a channel after approval.',
      definition: {
        steps: [
          {
            id: 'product',
            kind: 'ASK',
            attribute: 'product',
            prompt: { text: 'Hi! What can we help you with today?' },
            options: [
              { value: 'cards', label: 'Cards, EMI & statements', synonyms: ['card', 'emi', 'statement'] },
              { value: 'sales', label: 'Loans & new cards', synonyms: ['loan', 'apply'] },
              { value: 'collections', label: 'A payment I owe', synonyms: ['overdue', 'payment plan'] },
            ],
            maxAttempts: 2,
            skipIfKnown: true,
          },
        ],
        rules: [
          { when: { product: 'sales' }, queueId: queueIds.salesCallback },
          { when: { product: 'collections' }, queueId: queueIds.hardship },
        ],
        fallbackQueueId: queueIds.cardsT2,
        returning: { askAfter: { value: 7, unit: 'DAYS' }, prompt: { text: 'Welcome back! Continue where we left off, or start something new?' }, continueLabel: 'Continue', newLabel: 'Something new' },
        timeoutMinutes: 10,
      },
    });
    ctx.log(`created draft router "${EXAMPLE_MENU_ROUTER}"`);
  }
}

/**
 * Maker–checker for the demo's routing (PM/research/11 §4): the SLA policies and queues get their first
 * approval, then the web chat router its activation — each proposed by one demo Head and checked by the
 * other (never a self-approval). Queue proposals are all submitted before any is decided, so queues that
 * transfer to each other can be approved. Runs after the agents are live (a router needs live agents).
 */
export async function approveRouting(ctx: SeedContext, leads: Record<LeadKey, ActorContext>, queueIds: Record<QueueKey, string>): Promise<void> {
  const pairs: Array<[ActorContext, ActorContext]> = [
    [leads.lead, leads.lead2],
    [leads.lead2, leads.lead],
  ];
  const submit = async (kind: string, objectId: string, action: 'CREATE' | 'ACTIVATE', reason: string) => {
    for (const [maker, checker] of pairs) {
      try {
        return { checker, proposal: await ctx.services.approvals.submit(maker, { objectKind: kind, objectId, action, checkerId: checker.principal!.userId, reason }) };
      } catch (err) {
        // Out of this Head's write scope: the other Head proposes it.
        if ((err as { category?: string }).category !== 'not_found') throw err;
      }
    }
    throw new Error(`demo seed: no Head may propose ${kind} ${objectId}`);
  };
  const decide = (d: Awaited<ReturnType<typeof submit>>) => ctx.services.approvalDecisions.decide(d.checker, d.proposal.id, { decision: 'APPROVE', reason: 'Demo seed: reviewed', contentHash: d.proposal.contentHash });
  const todo = async (kind: string, ids: string[]) => {
    const gates = await approvalGates(ctx.db, kind, ids);
    return ids.filter((id) => gates.get(id) === 'none');
  };

  const policies = await todo('sla_policy', (await ctx.db.select({ id: slaPolicies.id }).from(slaPolicies)).map((p) => p.id));
  for (const id of policies) await decide(await submit('sla_policy', id, 'CREATE', 'Demo seed: SLA policy'));
  const queuesToApprove = await todo('queue', Object.values(queueIds));
  const submitted = [];
  for (const id of queuesToApprove) submitted.push(await submit('queue', id, 'CREATE', 'Demo seed: queue'));
  for (const d of submitted) await decide(d);
  if (policies.length || queuesToApprove.length) ctx.log(`approved ${policies.length} SLA policies and ${queuesToApprove.length} queues (each Head checks the other)`);

  const [router] = await ctx.db.select({ id: routers.id, status: routers.status }).from(routers).where(eq(routers.name, WEBCHAT_ROUTER));
  if (router && router.status === 'DRAFT') {
    const [latest] = await ctx.db.select({ id: routerVersions.id }).from(routerVersions).where(eq(routerVersions.routerId, router.id)).orderBy(desc(routerVersions.version)).limit(1);
    if (latest) {
      await decide(await submit('router', router.id, 'ACTIVATE', 'Demo seed: web chat answers as Maya'));
      ctx.log(`router "${WEBCHAT_ROUTER}" is live (approved)`);
    }
  }
}
