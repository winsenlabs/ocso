import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { conversations, handoffs, toolCalls, turns, usageEvents } from '@ocso/db';
import { HumanControlService, PromptService, sendHumanReply } from '@ocso/application';
import { LeaseLostError } from '../src/index.js';
import { createRuntimeHarness, turnMessage, type RuntimeHarness } from './harness.js';

let h: RuntimeHarness;

beforeAll(async () => {
  h = await createRuntimeHarness();
});
afterAll(async () => {
  await h?.t.drop();
});
beforeEach(async () => {
  h.adapter.script = [];
  h.adapter.requests = [];
  // Each test starts with a fresh visitor conversation.
  await h.t.pool.query(`UPDATE conversations SET control_state = 'RESOLVED', resolved_at = now() - interval '10 days' WHERE control_state <> 'RESOLVED'`);
  await h.t.pool.query('DELETE FROM conversation_leases');
});

const agentMessages = async (conversationId: string) =>
  (await h.t.pool.query(`SELECT i.id, p.content->>'text' AS text FROM interactions i JOIN interaction_parts p ON p.interaction_id = i.id WHERE i.conversation_id = $1 AND i.actor_type = 'AGENT' ORDER BY i.seq`, [conversationId])).rows as Array<{ id: string; text: string }>;

describe('turn execution', () => {
  it('answers a customer message, records usage and schedules delivery', async () => {
    h.adapter.script = [{ text: 'Thanks Priya — let me check that for you.' }];
    const conversationId = await h.say('My EMI was debited twice');
    const { processor } = h.processor('w1');
    expect(await processor.handle(turnMessage(conversationId))).toEqual({ kind: 'ack' });
    expect((await agentMessages(conversationId)).map((m) => m.text)).toEqual(['Thanks Priya — let me check that for you.']);
    const [conv] = await h.t.db.select().from(conversations).where(eq(conversations.id, conversationId));
    expect(conv!.lastProcessedSeq).toBe(1);
    const [turn] = await h.t.db.select().from(turns).where(eq(turns.conversationId, conversationId));
    expect(turn).toMatchObject({ status: 'COMPLETED', outcome: 'REPLIED', cacheLayer: 'COLD' });
    const usage = await h.t.db.select().from(usageEvents).where(eq(usageEvents.turnId, turn!.id));
    expect(usage[0]).toMatchObject({ status: 'OK', inputTokens: 1200, cachedInputTokens: 1000, purpose: 'TURN' });
    expect(h.queue.pending('channel.deliver')).toBeGreaterThan(0);
    // The compiled prompt carried stable prefix + cache key.
    expect(h.adapter.requests[0]!.cache.key).toMatch(/^ap_/);
    expect(h.adapter.requests[0]!.system[0]!.key).toBe('runtime_contract');
  });

  it('uses the warm (HOT) cache on the next turn of a leased conversation', async () => {
    h.adapter.script = [{ text: 'first' }, { text: 'second' }];
    const conversationId = await h.say('hello');
    const { processor } = h.processor('w-warm');
    await processor.handle(turnMessage(conversationId));
    await h.say('again');
    await processor.handle(turnMessage(conversationId));
    const rows = await h.t.db.select().from(turns).where(eq(turns.conversationId, conversationId)).orderBy(turns.startedAt);
    expect(rows.map((r) => r.cacheLayer)).toEqual(['COLD', 'HOT']);
  });

  it('invalidates the turn cache when a new prompt version is activated', async () => {
    h.adapter.script = [{ text: 'a' }, { text: 'b' }];
    const conversationId = await h.say('hi');
    const { processor } = h.processor('w-inv');
    await processor.handle(turnMessage(conversationId));
    const prompts = new PromptService(h.t.db);
    const draft = await prompts.draft(h.agentId);
    await prompts.saveDraft(h.lead, h.agentId, { ...draft.components, behavior: 'Be even more concise.' });
    const version = await prompts.createVersionFromDraft(h.lead, h.agentId, { reason: 'shorter replies' });
    await prompts.activate(h.lead, h.agentId, version.id);
    await h.say('hi again');
    await processor.handle(turnMessage(conversationId));
    const rows = await h.t.db.select().from(turns).where(eq(turns.conversationId, conversationId)).orderBy(turns.startedAt);
    expect(rows.map((r) => r.cacheLayer)).toEqual(['COLD', 'COLD']);
    expect(rows[0]!.contextHashes!['agentPrefixHash']).not.toBe(rows[1]!.contextHashes!['agentPrefixHash']);
    expect(JSON.stringify(h.adapter.requests.at(-1)!.system)).toContain('Be even more concise.');
  });
});

describe('leases, serialization and recovery', () => {
  it('produces exactly one reply when two workers race for the same conversation', async () => {
    h.adapter.script = [{ text: 'only once', delayMs: 150 }, { text: 'SHOULD NOT APPEAR' }];
    const conversationId = await h.say('race me');
    const a = h.processor('race-a').processor;
    const b = h.processor('race-b').processor;
    const results = await Promise.all([a.handle(turnMessage(conversationId)), b.handle(turnMessage(conversationId))]);
    expect(results.map((r) => r.kind).sort()).toEqual(['ack', 'defer']);
    expect((await agentMessages(conversationId)).map((m) => m.text)).toEqual(['only once']);
  });

  it('recovers a conversation from PostgreSQL after its worker died', async () => {
    h.adapter.script = [{ text: 'recovered reply' }];
    const conversationId = await h.say('are you there?');
    // Worker "dead" acquired the lease and crashed without heartbeating.
    await h.t.pool.query(
      `INSERT INTO conversation_leases (conversation_id, worker_id, lease_version, busy, expires_at) VALUES ($1, 'dead-worker', 7, true, now() - interval '1 second')`,
      [conversationId],
    );
    const { processor } = h.processor('survivor');
    expect(await processor.handle(turnMessage(conversationId))).toEqual({ kind: 'ack' });
    expect((await agentMessages(conversationId)).map((m) => m.text)).toEqual(['recovered reply']);
    const { rows } = await h.t.pool.query(`SELECT worker_id, lease_version FROM conversation_leases WHERE conversation_id = $1`, [conversationId]);
    expect(rows[0]).toMatchObject({ worker_id: 'survivor', lease_version: '8' });
  });

  it('fences stale workers: a transferred lease rejects the old writer', async () => {
    const conversationId = await h.say('fence');
    const w1 = h.processor('fence-1').leases;
    const w2 = h.processor('fence-2').leases;
    const first = await w1.acquire(conversationId);
    await h.t.pool.query(`UPDATE conversation_leases SET busy = false WHERE conversation_id = $1`, [conversationId]);
    const second = await w2.acquire(conversationId);
    expect(first.kind === 'acquired' && second.kind === 'acquired').toBe(true);
    await expect(h.t.db.transaction((tx) => w1.assertHeld(tx, conversationId, first.kind === 'acquired' ? first.leaseVersion : 0))).rejects.toBeInstanceOf(LeaseLostError);
  });

  it('drains messages that arrive mid-turn instead of dropping them', async () => {
    h.adapter.script = [{ text: 'answer one', delayMs: 100 }, { text: 'answer two' }];
    const conversationId = await h.say('first question');
    const { processor } = h.processor('drain');
    const running = processor.handle(turnMessage(conversationId));
    await new Promise((r) => setTimeout(r, 30));
    await h.say('second question');
    expect(await running).toEqual({ kind: 'ack' });
    expect((await agentMessages(conversationId)).map((m) => m.text)).toEqual(['answer one', 'answer two']);
  });
});

describe('human handoff lifecycle', () => {
  it('routes to the queue when the agent requests a handoff', async () => {
    h.adapter.script = [
      { toolCalls: [{ toolName: 'ocso_request_handoff', input: { reason: 'refund above authority', summary: 'duplicate debit\nchecked ledger\napprove reversal', priority: 'P1' } }] },
      { text: 'A colleague from the cards team will confirm here shortly.' },
    ];
    const conversationId = await h.say('please reverse one of them');
    await h.processor('hand').processor.handle(turnMessage(conversationId));
    const [conv] = await h.t.db.select().from(conversations).where(eq(conversations.id, conversationId));
    expect(conv).toMatchObject({ controlState: 'WAITING_FOR_HUMAN', priority: 'P1', queueId: h.queueId });
    const [handoff] = await h.t.db.select().from(handoffs).where(eq(handoffs.conversationId, conversationId));
    expect(handoff).toMatchObject({ trigger: 'AGENT_DECISION', status: 'WAITING', reasonText: 'refund above authority' });
    expect((await agentMessages(conversationId)).at(-1)!.text).toContain('colleague');
  });

  it('never lets the AI reply while a human owns the conversation, and resumes after return-to-AI', async () => {
    h.adapter.script = [{ text: 'too late', delayMs: 120 }];
    const conversationId = await h.say('I need help');
    const { processor } = h.processor('takeover');
    const running = processor.handle(turnMessage(conversationId));
    await new Promise((r) => setTimeout(r, 30));
    const human = new HumanControlService(h.t.db);
    await human.takeOver(h.lead, conversationId);
    await running;
    expect(await agentMessages(conversationId)).toEqual([]);
    const [turn] = await h.t.db.select().from(turns).where(eq(turns.conversationId, conversationId));
    expect(turn!.status).toBe('SUPERSEDED');

    await sendHumanReply(h.t.db, h.queue, h.lead, conversationId, { parts: [{ type: 'TEXT', text: 'Nikhil here, reversing now.' }], clientMessageId: 'client-msg-0001' });
    await h.say('thanks, is it done?');
    await processor.handle(turnMessage(conversationId));
    expect(await agentMessages(conversationId)).toEqual([]);

    await human.returnToAi(h.lead, conversationId, { handoverSummary: 'Reversal RVSL-5521904 done; EMI unchanged.' });
    h.adapter.script = [{ text: 'Your reversal reference is RVSL-5521904.' }];
    await h.say('what was the reference?');
    await processor.handle(turnMessage(conversationId));
    const [conv] = await h.t.db.select().from(conversations).where(eq(conversations.id, conversationId));
    expect(conv!.controlState).toBe('AI_ACTIVE');
    expect((await agentMessages(conversationId)).map((m) => m.text)).toEqual(['Your reversal reference is RVSL-5521904.']);
    const lastSystem = JSON.stringify(h.adapter.requests.at(-1)!.system);
    expect(lastSystem).toContain('RVSL-5521904 done');
    expect(lastSystem).toContain('<handover>');
    // Only the new question is "current"; the human-handled messages are history.
    const current = h.adapter.requests.at(-1)!.messages.at(-1)!;
    expect(JSON.stringify(current)).toContain('what was the reference?');
  });

  it('awaits human confirmation for sensitive tools and escalates as P1', async () => {
    const connectionId = (await h.t.pool.query(
      `INSERT INTO mcp_connections (id, name, url, status, allowed_agent_ids, granted_scopes) VALUES (gen_random_uuid(), 'core-cards', 'https://mcp.example/cards', 'ACTIVE', '{*}', '{}') RETURNING id`,
    )).rows[0].id as string;
    const toolId = (await h.t.pool.query(
      `INSERT INTO tools (id, connection_id, name, model_name, description, input_schema, schema_hash, suggested_risk, risk_class, approved)
       VALUES (gen_random_uuid(), $1, 'payments.reverse_transaction', 'core-cards__payments_reverse_transaction', 'Reverse a settled debit',
               '{"type":"object","properties":{"txnId":{"type":"string"},"amount":{"type":"number"}},"required":["txnId","amount"]}', 'h', 'SENSITIVE', 'SENSITIVE', true) RETURNING id`,
      [connectionId],
    )).rows[0].id as string;
    await h.t.pool.query(`INSERT INTO agent_tool_grants (agent_id, tool_id) VALUES ($1, $2)`, [h.agentId, toolId]);
    await h.t.pool.query(`INSERT INTO cache_generations (scope, generation) VALUES ($1, 99) ON CONFLICT (scope) DO UPDATE SET generation = 99`, [`agent:${h.agentId}`]);

    h.adapter.script = [
      { text: 'Let me raise that reversal now.', toolCalls: [{ toolName: 'core-cards__payments_reverse_transaction', input: { txnId: 'TXN-8841-2290', amount: 12480 } }] },
      { text: 'A colleague needs to confirm this reversal; they will reply here shortly.' },
    ];
    const conversationId = await h.say('reverse TXN-8841-2290 please');
    await h.processor('sensitive').processor.handle(turnMessage(conversationId));
    const [call] = await h.t.db.select().from(toolCalls).where(eq(toolCalls.conversationId, conversationId));
    expect(call).toMatchObject({ status: 'AWAITING_CONFIRMATION', actorType: 'AGENT' });
    const [conv] = await h.t.db.select().from(conversations).where(eq(conversations.id, conversationId));
    expect(conv).toMatchObject({ controlState: 'WAITING_FOR_HUMAN', priority: 'P1' });
    const [handoff] = await h.t.db.select().from(handoffs).where(eq(handoffs.conversationId, conversationId));
    expect(handoff!.trigger).toBe('SENSITIVE_ACTION');
    expect((await agentMessages(conversationId)).map((m) => m.text)).toEqual([
      'Let me raise that reversal now.',
      'A colleague needs to confirm this reversal; they will reply here shortly.',
    ]);
    const tools = h.adapter.requests[0]!.tools.map((t) => t.name);
    expect(tools).toContain('core-cards__payments_reverse_transaction');
    expect(tools).toContain('ocso_request_handoff');
    const { rows } = await h.t.db.execute(sql`SELECT count(*)::int AS n FROM outbox_events WHERE type = 'tool.confirmation_requested'`);
    expect((rows[0] as { n: number }).n).toBe(1);
  });
});
