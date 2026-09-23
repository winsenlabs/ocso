import { and, asc, eq } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from '@ocso/db/testing';
import { channels, conversationRouting, conversations, customers, interactionParts, interactions, modelProfiles, modelProviders, queues, teams, uuidv7, virtualAgents } from '@ocso/db';
import type { Principal } from '@ocso/auth';
import type { InteractionPart, RouterDefinition } from '@ocso/domain';
import { MemoryQueue, type PublishOptions, type Topic } from '@ocso/queue';
import { AgentService, IngressService, RoutingEngine, createActiveRouter, type ActorContext, type RouterClassifier } from '../../src/index.js';

/** A MemoryQueue that remembers what was published (topic + payload), for assertions. */
export class RecordingQueue extends MemoryQueue {
  readonly published: Array<{ topic: Topic; payload: Record<string, unknown> }> = [];
  override async publish<T>(topic: Topic, payload: T, opts?: PublishOptions): Promise<void> {
    this.published.push({ topic, payload: payload as Record<string, unknown> });
    return super.publish(topic, payload, opts);
  }
  count(topic: Topic, conversationId?: string): number {
    return this.published.filter((p) => p.topic === topic && (!conversationId || p.payload['conversationId'] === conversationId)).length;
  }
}

export interface RoutingFixture {
  t: TestDatabase;
  queue: RecordingQueue;
  ingress: IngressService;
  engine: RoutingEngine;
  lead: Principal;
  actor: ActorContext;
  agents: { maya: string; arjun: string };
  queues: { cards: string; sales: string };
  classify: { impl: RouterClassifier | null };
  now: { value: Date };
  /** A WHATSAPP channel whose active router has this definition (placeholders CARDS/SALES are queue ids). */
  channelWith(definition: RouterDefinition, name?: string): Promise<string>;
  say(channelId: string, text: string, phone: string, parts?: InteractionPart[]): Promise<{ conversationId: string; seq: number; created: boolean; routeQueued: boolean; turnQueued: boolean }>;
  conversation(id: string): Promise<typeof conversations.$inferSelect>;
  routing(id: string): Promise<typeof conversationRouting.$inferSelect | undefined>;
  /** Customer-visible outbound router messages, oldest first, with their parts. */
  routerMessages(conversationId: string): Promise<Array<{ seq: number; parts: InteractionPart[] }>>;
  systemEvents(conversationId: string, schema: string): Promise<string[]>;
  drop(): Promise<void>;
}

export async function createRoutingFixture(): Promise<RoutingFixture> {
  const t = await createTestDatabase();
  const queue = new RecordingQueue();
  const TEAM = uuidv7();
  const lead: Principal = { userId: uuidv7(), role: 'HEAD', displayName: 'Anjali Rao', teamIds: [TEAM], via: 'UI' };
  const actor: ActorContext = { principal: lead, correlationId: 'test' };
  await t.pool.query(`INSERT INTO users (id, email, name, role) VALUES ($1, 'lead@routing.test', 'Anjali Rao', 'HEAD')`, [lead.userId]);
  await t.db.insert(teams).values({ id: TEAM, name: 'Cards' });
  const agentsService = new AgentService(t.db);
  const maya = (await agentsService.create(actor, { name: 'Maya', purpose: 'support', conversationType: 'SUPPORT', description: '', teamIds: [TEAM] })).id;
  const arjun = (await agentsService.create(actor, { name: 'Arjun', purpose: 'sales', conversationType: 'SALES', description: '', teamIds: [TEAM] })).id;
  const [cards, sales] = [uuidv7(), uuidv7()];
  await t.db.insert(queues).values([
    { id: cards, name: 'Cards', agentId: maya, attributes: { product: 'cards' } },
    { id: sales, name: 'Sales', agentId: arjun, attributes: { product: 'sales' } },
  ]);
  // A model profile for CLASSIFY steps (the placeholder PROFILE in definitions).
  const providerId = uuidv7();
  const profileId = uuidv7();
  await t.db.insert(modelProviders).values({ id: providerId, kind: 'DEV_SCRIPTED', name: 'Scripted', residencyZone: 'IN' });
  await t.db.insert(modelProfiles).values({ id: profileId, name: 'router-classifier', providerId, model: 'scripted', retries: 0 });
  // Live agents with a model: the ones the turn processor runs (routing prefers them).
  await t.db.update(virtualAgents).set({ status: 'LIVE', modelProfileId: profileId });
  const now = { value: new Date() };
  const classify: RoutingFixture['classify'] = { impl: null };
  const ingress = new IngressService(t.db, queue, { reopenWindowHours: 72, now: () => now.value });
  const engine = new RoutingEngine({ db: t.db, queue, classifier: (r) => (classify.impl ? classify.impl(r) : Promise.resolve({ label: null, confidence: 0, followUp: null })), now: () => now.value });
  let counter = 0;
  const swap = (def: RouterDefinition): RouterDefinition => JSON.parse(JSON.stringify(def).replaceAll('"CARDS"', `"${cards}"`).replaceAll('"SALES"', `"${sales}"`).replaceAll('"PROFILE"', `"${profileId}"`));

  return {
    t,
    queue,
    ingress,
    engine,
    lead,
    actor,
    agents: { maya, arjun },
    queues: { cards, sales },
    classify,
    now,
    async channelWith(definition, name) {
      const id = uuidv7();
      const label = name ?? `Channel ${++counter}`;
      await t.db.insert(channels).values({ id, kind: 'WHATSAPP', name: label, status: 'ACTIVE', publicKey: `pk-${id.slice(-8)}` });
      await createActiveRouter(t.db, actor, { name: label, definition: swap(definition), channelIds: [id] });
      return id;
    },
    async say(channelId, text, phone, parts) {
      const r = await ingress.receive(
        channelId,
        { externalMessageId: `m-${++counter}-${Math.random().toString(36).slice(2)}`, identityKind: 'whatsapp_phone', identityValue: phone, alternateIdentities: [], profileName: 'Priya', receivedAt: now.value, parts: parts ?? [{ type: 'TEXT', text }] },
        'test',
      );
      if (r.status !== 'accepted') throw new Error(`ingress ${r.status}${'reason' in r ? ` ${r.reason}` : ''}`);
      return r;
    },
    async conversation(id) {
      const [row] = await t.db.select().from(conversations).where(eq(conversations.id, id));
      return row!;
    },
    async routing(id) {
      const [row] = await t.db.select().from(conversationRouting).where(eq(conversationRouting.conversationId, id));
      return row;
    },
    async routerMessages(conversationId) {
      const rows = await t.db
        .select({ id: interactions.id, seq: interactions.seq })
        .from(interactions)
        .where(and(eq(interactions.conversationId, conversationId), eq(interactions.actorType, 'ROUTER')))
        .orderBy(asc(interactions.seq));
      const out: Array<{ seq: number; parts: InteractionPart[] }> = [];
      for (const r of rows) {
        const parts = await t.db.select().from(interactionParts).where(eq(interactionParts.interactionId, r.id)).orderBy(asc(interactionParts.idx));
        out.push({ seq: r.seq, parts: parts.map((p) => p.content as unknown as InteractionPart) });
      }
      return out;
    },
    async systemEvents(conversationId, schema) {
      const rows = await t.db
        .select({ content: interactionParts.content })
        .from(interactionParts)
        .innerJoin(interactions, eq(interactions.id, interactionParts.interactionId))
        .where(and(eq(interactions.conversationId, conversationId), eq(interactions.kind, 'SYSTEM_EVENT')))
        .orderBy(asc(interactions.seq));
      return rows.flatMap((r) => {
        const c = r.content as { schema?: string; fallbackText?: string };
        return c.schema === schema ? [c.fallbackText ?? ''] : [];
      });
    },
    drop: () => t.drop(),
  };
}

/** Set a customer's language (KNOWN steps read it). */
export async function setCustomerLanguage(t: TestDatabase, conversationOrPhone: { customerId: string }, language: string): Promise<void> {
  await t.db.update(customers).set({ language }).where(eq(customers.id, conversationOrPhone.customerId));
}
