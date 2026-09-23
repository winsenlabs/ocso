import { eq } from 'drizzle-orm';
import { RouterService, createPassThroughRouter, recordAudit, type ActorContext } from '@ocso/application';
import { channels, queues, routers } from '@ocso/db';
import type { SeedContext } from '../context.js';
import type { AgentKey } from '../data/agents.js';
import type { QueueKey } from '../data/organization.js';

/** Each demo queue's AI agent and attributes (PM/research/11 §5.5): the service unit. */
const SERVICE: ReadonlyArray<{ queue: QueueKey; agent: AgentKey; attributes: Record<string, string>; transferTo: QueueKey[] }> = [
  { queue: 'cardsT2', agent: 'maya', attributes: { product: 'cards' }, transferTo: ['salesCallback'] },
  { queue: 'salesCallback', agent: 'arjun', attributes: { product: 'sales' }, transferTo: ['cardsT2'] },
  { queue: 'hardship', agent: 'riya', attributes: { product: 'collections' }, transferTo: [] },
];

export const WEBCHAT_ROUTER = 'Meridian web chat';
export const EXAMPLE_MENU_ROUTER = 'Meridian menu (example)';

/**
 * Routing for the demo: queues get their agent, attributes and transfer
 * targets; the web chat keeps answering as Maya through a pass-through router
 * (made live directly: seeds are the trusted setup path); and a menu router is
 * left as an editable draft to show the builder.
 */
export async function seedRouters(ctx: SeedContext, admin: ActorContext, lead: ActorContext, agents: Record<AgentKey, string>, queueIds: Record<QueueKey, string>, webchatChannelId: string): Promise<void> {
  for (const s of SERVICE) {
    const [row] = await ctx.db.select({ agentId: queues.agentId }).from(queues).where(eq(queues.id, queueIds[s.queue]));
    if (row?.agentId) continue;
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
    await createPassThroughRouter(ctx.db, admin, { name: WEBCHAT_ROUTER, queueId: queueIds.cardsT2, channelIds: [webchatChannelId] });
    ctx.log(`web chat routes through "${WEBCHAT_ROUTER}" (pass-through to Maya)`);
  }
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
