import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asc, eq, sql } from 'drizzle-orm';
import {
  conversations,
  customers,
  evaluationResults,
  evaluationRuns,
  interactionParts,
  interactions,
  mcpConnections,
  toolCalls,
  tools,
  turns,
  uuidv7,
  virtualAgents,
} from '@ocso/db';
import { SettingsService, initialComponents } from '@ocso/application';
import { ModelGateway, UsageRecorder, HANDOFF_TOOL } from '../src/index.js';
import { EvaluationService, pickCase } from '../src/jobs/evaluation.js';
import { createRuntimeHarness, type RuntimeHarness } from './harness.js';

let h: RuntimeHarness;
let service: EvaluationService;
const MARKER = 'NEW BEHAVIOR MARKER: check the ledger first.';
const conv: Record<string, string> = {};

type Msg = ['CUSTOMER' | 'AGENT', string, { turnOutcome?: 'REPLIED' | 'HANDOFF'; tools?: string[] }?];

/** A conversation with customer-visible messages; agent messages get a turn row (and optional tool calls). */
async function seed(key: string, agentId: string, resolvedMinutesAgo: number | null, messages: Msg[]) {
  const customerId = uuidv7();
  await h.t.db.insert(customers).values({ id: customerId, displayName: `Customer ${key}` });
  const id = uuidv7();
  conv[key] = id;
  const opened = new Date(Date.now() - 86_400_000);
  await h.t.db.insert(conversations).values({
    id, customerId, agentId, type: 'SUPPORT', controlState: resolvedMinutesAgo === null ? 'AI_ACTIVE' : 'RESOLVED', openedAt: opened, lastSeq: messages.length,
    resolvedAt: resolvedMinutesAgo === null ? null : new Date(Date.now() - resolvedMinutesAgo * 60_000),
  });
  let seq = 0;
  for (const [actorType, text, meta] of messages) {
    seq++;
    let turnId: string | null = null;
    if (actorType === 'AGENT') {
      turnId = uuidv7();
      await h.t.db.insert(turns).values({ id: turnId, conversationId: id, workerId: 'w', leaseVersion: 1, seqFrom: seq - 1, seqTo: seq - 1, status: 'COMPLETED', outcome: meta?.turnOutcome ?? 'REPLIED' });
      for (const [i, name] of (meta?.tools ?? []).entries()) {
        const [tool] = await h.t.db.select().from(tools).where(eq(tools.modelName, name));
        const at = new Date(opened.getTime() + seq * 60_000 + i);
        await h.t.db.insert(toolCalls).values({ id: uuidv7(), conversationId: id, turnId, toolId: tool?.id ?? null, toolName: 'cards.list_transactions', actorType: 'AGENT', actorId: agentId, argsSanitized: {}, argsHash: 'h', status: 'SUCCEEDED', requestedAt: at, completedAt: new Date(at.getTime() + 500) });
      }
    }
    const iid = uuidv7();
    await h.t.db.insert(interactions).values({ id: iid, conversationId: id, seq, actorType, direction: actorType === 'CUSTOMER' ? 'INBOUND' : 'OUTBOUND', visibility: 'CUSTOMER', correlationId: 'seed', turnId, createdAt: new Date(opened.getTime() + seq * 60_000) });
    await h.t.db.insert(interactionParts).values({ id: uuidv7(), interactionId: iid, idx: 0, type: 'TEXT', content: { type: 'TEXT', text } });
  }
}

async function createRun(agentId: string, caseCount: number) {
  const id = uuidv7();
  await h.t.db.insert(evaluationRuns).values({ id, agentId, candidateComponents: { ...initialComponents('Maya', 'customer support', 'SUPPORT'), behavior: MARKER }, caseCount });
  return id;
}

beforeAll(async () => {
  h = await createRuntimeHarness();
  service = new EvaluationService(h.t.db, new ModelGateway(h.t.db, { get: async () => h.adapter }, new UsageRecorder(h.t.db), new SettingsService(h.t.db)));
  const connectionId = uuidv7();
  await h.t.db.insert(mcpConnections).values({ id: connectionId, name: 'core-cards', url: 'https://mcp.example/cards', status: 'ACTIVE' });
  await h.t.db.insert(tools).values({ id: uuidv7(), connectionId, name: 'cards.list_transactions', modelName: 'core_cards__list_transactions', inputSchema: {}, schemaHash: 'h', suggestedRisk: 'READ', riskClass: 'READ', approved: true });
  // Resolved most recently first: A, B, C, D, E. F is open (never sampled).
  await seed('A', h.agentId, 1, [['CUSTOMER', 'Hi'], ['AGENT', 'Hello there'], ['CUSTOMER', 'my EMI was debited twice'], ['AGENT', 'I can see two debits. Shall I reverse one?']]);
  await seed('B', h.agentId, 2, [['CUSTOMER', 'refund 12480 please'], ['AGENT', 'That is above my authority, connecting you', { turnOutcome: 'HANDOFF' }]]);
  await seed('C', h.agentId, 3, [['CUSTOMER', 'show my last transactions'], ['AGENT', 'Here are your last 3 transactions', { tools: ['core_cards__list_transactions'] }]]);
  await seed('D', h.agentId, 4, [['CUSTOMER', 'hello'], ['AGENT', 'Hi! How can I help?']]);
  await seed('E', h.agentId, 5, [['AGENT', 'Welcome!'], ['CUSTOMER', 'thanks']]);
  await seed('F', h.agentId, null, [['CUSTOMER', 'open one'], ['AGENT', 'still open']]);
});
afterAll(async () => {
  await h?.t.drop();
});

describe('replay evaluation', () => {
  it('picks the latest agent reply that answers a customer message', () => {
    const e = (seq: number, actorType: 'CUSTOMER' | 'AGENT', text: string) => ({ seq, actorType, parts: [{ type: 'TEXT' as const, text }] });
    const picked = pickCase([e(1, 'CUSTOMER', 'a'), e(2, 'AGENT', 'b'), e(3, 'CUSTOMER', 'c'), e(4, 'CUSTOMER', 'd'), e(5, 'AGENT', 'e'), e(6, 'AGENT', 'f')], 20);
    expect(picked).toMatchObject({ seq: 4, baselineText: 'e\nf' });
    expect(picked!.current.map((x) => x.seq)).toEqual([3, 4]);
    expect(picked!.recent.map((x) => x.seq)).toEqual([1, 2]);
    expect(pickCase([e(1, 'AGENT', 'hi'), e(2, 'CUSTOMER', 'x')], 20)).toBeNull();
  });

  it('replays the candidate prompt on historical turns without executing tools', async () => {
    const toolCallsBefore = await h.t.db.$count(toolCalls);
    h.adapter.script = [
      { text: '  i can SEE two debits.   shall i reverse one? ' }, // A: same reply after normalization
      { toolCalls: [{ toolName: HANDOFF_TOOL, input: { reason: 'refund above authority', summary: 'x' } }] }, // B: handoff like the baseline
      { toolCalls: [{ toolName: 'core_cards__get_balance', input: { account: 'x', password: 'hunter2' } }] }, // C: different tool
      { text: 'Welcome to Meridian Bank' }, // D: different text
    ];
    const runId = await createRun(h.agentId, 10);
    const outcome = await service.run(runId, 'eval-test');
    expect(outcome).toEqual({
      status: 'COMPLETED',
      summary: { cases: 4, changed: 2, unchanged: 2, handoff_requested: 1, handoff_differs: 0, tool_call_differs: 1, empty_reply: 0, errors: 0, skipped: 1 },
    });
    expect(await h.t.db.$count(toolCalls)).toBe(toolCallsBefore); // nothing executed

    const first = h.adapter.requests.at(-4)!;
    expect(first.purpose).toBe('EVALUATION');
    expect(first.system.map((b) => b.text).join('\n')).toContain(MARKER);
    expect(first.tools.map((t) => t.name)).toContain(HANDOFF_TOOL);
    const lastMessage = JSON.stringify(first.messages.at(-1));
    expect(lastMessage).toContain('my EMI was debited twice');
    expect(JSON.stringify(first.messages)).toContain('Hello there');
    expect(JSON.stringify(first.messages)).not.toContain('Shall I reverse one'); // the baseline answer is never shown to the candidate

    const results = await h.t.db.select().from(evaluationResults).where(eq(evaluationResults.runId, runId)).orderBy(asc(evaluationResults.createdAt));
    const by = (key: string) => results.find((r) => r.conversationId === conv[key])!;
    expect(by('A')).toMatchObject({ seq: 3, changed: false, flags: [], customerText: 'my EMI was debited twice', baselineText: 'I can see two debits. Shall I reverse one?' });
    expect(by('B')).toMatchObject({ changed: false, flags: ['handoff_requested'], candidateText: null });
    expect(by('C')).toMatchObject({ changed: true, flags: ['tool_call_differs'] });
    expect(JSON.stringify(by('C').candidateToolCalls)).not.toContain('hunter2');
    expect(by('D')).toMatchObject({ changed: true, flags: [], candidateText: 'Welcome to Meridian Bank' });
    expect(results.some((r) => r.conversationId === conv['E'] || r.conversationId === conv['F'])).toBe(false);
    const [run] = await h.t.db.select().from(evaluationRuns).where(eq(evaluationRuns.id, runId));
    expect(run).toMatchObject({ status: 'COMPLETED', summary: outcome.summary });
    expect(run!.completedAt).toBeInstanceOf(Date);
    expect(await service.run(runId)).toEqual({ status: 'SKIPPED' }); // idempotent redelivery
  });

  it('records model failures per case and keeps going', async () => {
    h.adapter.script = [{ error: new Error('boom') }, { text: 'Hi! How can I help?' }];
    const runId = await createRun(h.agentId, 2);
    const outcome = await service.run(runId);
    expect(outcome.summary).toMatchObject({ cases: 2, errors: 1, unchanged: 0, changed: 1 });
    const flags = (await h.t.db.select({ flags: evaluationResults.flags }).from(evaluationResults).where(eq(evaluationResults.runId, runId))).map((r) => r.flags);
    expect(flags).toContainEqual(['error']);
  });

  it('fails runs for agents without a model profile and restarts cleanly on redelivery', async () => {
    const bare = uuidv7();
    await h.t.db.insert(virtualAgents).values({ id: bare, name: 'No Model', slug: 'no-model', conversationType: 'SUPPORT' });
    expect(await service.run(await createRun(bare, 5))).toMatchObject({ status: 'FAILED' });

    // A RUNNING run (worker died mid-run) is redone from scratch: stale results are removed.
    const runId = await createRun(h.agentId, 1);
    await h.t.db.update(evaluationRuns).set({ status: 'RUNNING' }).where(eq(evaluationRuns.id, runId));
    await h.t.db.insert(evaluationResults).values({ id: uuidv7(), runId, conversationId: conv['A']!, seq: 99, customerText: 'stale' });
    h.adapter.script = [{ text: 'I can see two debits. Shall I reverse one?' }];
    expect((await service.run(runId)).summary).toMatchObject({ cases: 1, unchanged: 1 });
    const rows = await h.t.db.select({ n: sql<number>`count(*)::int` }).from(evaluationResults).where(eq(evaluationResults.runId, runId));
    expect(rows[0]!.n).toBe(1);
  });
});
