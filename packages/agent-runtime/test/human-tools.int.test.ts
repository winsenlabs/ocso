import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, desc, eq } from 'drizzle-orm';
import { toolCalls } from '@ocso/db';
import { connectionToolSource, createAjvValidator } from '@ocso/tools';
import type { Principal } from '@ocso/auth';
import { randomBytes } from 'node:crypto';
import { CustomerClaimsIssuer } from '@ocso/application';
import { InMemorySecretRows, LocalSecretStore, parseMasterKey } from '@ocso/secrets';
import { HumanToolService, createToolProviderRegistry, expireToolConfirmations } from '../src/index.js';
import { createRuntimeHarness, turnMessage, type RuntimeHarness } from './harness.js';

let h: RuntimeHarness;
const invoked: Array<{ toolName: string; args: unknown; customerClaims?: string | undefined; scope?: unknown }> = [];
let service: HumanToolService;
let toolId: string;
let exec: Principal;
let visitors = 0;

beforeAll(async () => {
  h = await createRuntimeHarness();
  const connectionId = (await h.t.pool.query(
    `INSERT INTO mcp_connections (id, name, url, status, allowed_agent_ids) VALUES (gen_random_uuid(), 'core-cards', 'https://mcp.example/cards', 'ACTIVE', '{*}') RETURNING id`,
  )).rows[0].id as string;
  toolId = (await h.t.pool.query(
    `INSERT INTO tools (id, connection_id, name, model_name, description, input_schema, schema_hash, suggested_risk, risk_class, approved, human_roles)
     VALUES (gen_random_uuid(), $1, 'payments.reverse_transaction', 'core-cards__payments_reverse_transaction', 'Reverse a settled debit',
       '{"type":"object","properties":{"txnId":{"type":"string"},"card":{"type":"string"},"amount":{"type":"number"}},"required":["txnId","amount"]}', 'h', 'SENSITIVE', 'SENSITIVE', true, '{SERVICE,HEAD}') RETURNING id`,
    [connectionId],
  )).rows[0].id as string;
  await h.t.pool.query(`INSERT INTO agent_tool_grants (agent_id, tool_id) VALUES ($1, $2)`, [h.agentId, toolId]);
  const execId = (await h.t.pool.query(`INSERT INTO users (id, email, name, role) VALUES (gen_random_uuid(), 'nikhil@x.test', 'Nikhil Menon', 'SERVICE') RETURNING id`)).rows[0].id;
  exec = { userId: execId, role: 'SERVICE', displayName: 'Nikhil Menon', teamIds: [], via: 'UI' };
  service = new HumanToolService(
    h.t.db,
    createToolProviderRegistry(
      h.t.db,
      connectionToolSource('test-mcp', { forConnection: async () => ({ connectionId, invoke: async (call) => { invoked.push({ toolName: call.toolName, args: call.args, customerClaims: call.customerClaims, scope: call.scope }); return { status: 'SUCCEEDED', output: { type: 'json', value: { reference: 'RVSL-5521904' } }, latencyMs: 12 }; } }) }),
    ),
    createAjvValidator(),
    new CustomerClaimsIssuer({ db: h.t.db, secrets: new LocalSecretStore(new InMemorySecretRows(), parseMasterKey('k', randomBytes(32).toString('base64'))), issuer: 'https://ocso.test' }),
  );
});
afterAll(async () => {
  await h?.t.drop();
});

async function proposeReversal(): Promise<string> {
  h.adapter.script = [
    { toolCalls: [{ toolName: 'core-cards__payments_reverse_transaction', input: { txnId: 'TXN-8841-2290', card: '4111 1111 1111 4417', amount: 12480 } }] },
    { text: 'A colleague will confirm.' },
  ];
  const conversationId = await h.say('please reverse the duplicate debit', undefined, `visitor-${++visitors}`);
  await h.processor(`w-${Math.random()}`).processor.handle(turnMessage(conversationId));
  const [call] = await h.t.db
    .select()
    .from(toolCalls)
    .where(and(eq(toolCalls.conversationId, conversationId), eq(toolCalls.status, 'AWAITING_CONFIRMATION')))
    .orderBy(desc(toolCalls.requestedAt))
    .limit(1);
  return call!.id;
}

describe('sensitive tool confirmation (docs/archive/specs/08 §7)', () => {
  it('executes exactly the proposed arguments, attributed to the confirming human', async () => {
    const id = await proposeReversal();
    const [before] = await h.t.db.select().from(toolCalls).where(eq(toolCalls.id, id));
    expect(before!.argsSanitized).toMatchObject({ card: '••••4417' });
    const result = await service.confirm({ principal: exec, correlationId: 'c' }, id);
    expect(result.status).toBe('SUCCEEDED');
    expect(invoked.at(-1)).toEqual({ toolName: 'payments.reverse_transaction', args: { txnId: 'TXN-8841-2290', card: '4111 1111 1111 4417', amount: 12480 } });
    const [after] = await h.t.db.select().from(toolCalls).where(eq(toolCalls.id, id));
    expect(after).toMatchObject({ status: 'SUCCEEDED', confirmedBy: exec.userId, pendingArgs: null });
    const { rows } = await h.t.pool.query(`SELECT action FROM audit_events WHERE target_id = $1`, [id]);
    expect(rows.map((r) => r.action)).toContain('tool.confirm');
    await expect(service.confirm({ principal: exec, correlationId: 'c' }, id)).rejects.toMatchObject({ code: 'not_awaiting_confirmation' });
  });

  it('refuses confirmation from a role not allowed to run the tool', async () => {
    const id = await proposeReversal();
    await h.t.pool.query(`UPDATE tools SET human_roles = '{HEAD}' WHERE id = $1`, [toolId]);
    try {
      await expect(service.confirm({ principal: exec, correlationId: 'c' }, id)).rejects.toMatchObject({ category: 'policy_denied' });
    } finally {
      await h.t.pool.query(`UPDATE tools SET human_roles = '{SERVICE,HEAD}' WHERE id = $1`, [toolId]);
    }
    // Still pending: a refused confirmation does not consume the proposal.
    const [row] = await h.t.db.select().from(toolCalls).where(eq(toolCalls.id, id));
    expect(row!.status).toBe('AWAITING_CONFIRMATION');
  });

  it('denial and expiry clear the held arguments', async () => {
    const denied = await proposeReversal();
    await service.deny({ principal: exec, correlationId: 'c' }, denied, 'customer withdrew the request');
    const [d] = await h.t.db.select().from(toolCalls).where(eq(toolCalls.id, denied));
    expect(d).toMatchObject({ status: 'DENIED', pendingArgs: null });

    const expiring = await proposeReversal();
    await h.t.pool.query(`UPDATE tool_calls SET confirmation_expires_at = now() - interval '1 minute' WHERE id = $1`, [expiring]);
    expect(await expireToolConfirmations(h.t.db)).toBeGreaterThanOrEqual(1);
    const [e] = await h.t.db.select().from(toolCalls).where(eq(toolCalls.id, expiring));
    expect(e).toMatchObject({ status: 'EXPIRED', pendingArgs: null });
  });

  it('lets a human run an approved tool only with explicit confirmation for sensitive tools', async () => {
    const conversationId = await h.say('human tool run', undefined, `visitor-${++visitors}`);
    await expect(service.run({ principal: exec, correlationId: 'c' }, conversationId, toolId, { txnId: 'T1', amount: 10 }, false)).rejects.toMatchObject({ code: 'confirmation_required' });
    const done = await service.run({ principal: exec, correlationId: 'c' }, conversationId, toolId, { txnId: 'T1', amount: 10 }, true);
    expect(done.status).toBe('SUCCEEDED');
    const [row] = await h.t.db.select().from(toolCalls).where(eq(toolCalls.id, done.toolCallId));
    expect(row).toMatchObject({ actorType: 'HUMAN', actorId: exec.userId, confirmedBy: exec.userId });
  });

  it('attaches signed customer claims only for trusted connections', async () => {
    const plain = await proposeReversal();
    await service.confirm({ principal: exec, correlationId: 'c' }, plain);
    expect(invoked.at(-1)!.customerClaims).toBeUndefined();

    await h.t.pool.query(`UPDATE mcp_connections SET send_customer_claims = true`);
    const trusted = await proposeReversal();
    await service.confirm({ principal: exec, correlationId: 'c' }, trusted);
    const token = invoked.at(-1)!.customerClaims!;
    const payload = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString());
    const [call] = await h.t.db.select().from(toolCalls).where(eq(toolCalls.id, trusted));
    const { rows } = await h.t.pool.query(`SELECT customer_id, agent_id FROM conversations WHERE id = $1`, [call!.conversationId]);
    expect(payload).toMatchObject({ iss: 'https://ocso.test', sub: `ocso:customer:${rows[0].customer_id}`, cid: call!.conversationId, agt: rows[0].agent_id });
  });
});
