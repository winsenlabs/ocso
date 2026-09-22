import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Client as V1Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport as V1Transport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyClaims } from '../../../examples/mcp-bank-demo/src/request-context.js';
import { formatInr } from '../../../examples/mcp-bank-demo/src/data/customers.js';
import { McpToolProvider } from '../src/index.js';
import { startDemo, type DemoServer } from './helpers/demo-server.js';
import { deps, InMemoryCredentials, target } from './helpers/fixtures.js';

const TOKEN = 'demo-bearer-token-abcdefgh';
type ToolOutcomeJson = Record<string, unknown>;

describe('Meridian core demo server (external example system)', () => {
  let demo: DemoServer;
  let provider: McpToolProvider;

  const run = async (toolName: string, args: Record<string, unknown>, idempotencyKey?: string): Promise<ToolOutcomeJson> => {
    const out = await provider.invoke({ toolCallId: toolName, toolName, args, timeoutMs: 5_000, idempotencyKey });
    if (out.status !== 'SUCCEEDED' || out.output.type !== 'json') throw new Error(`unexpected ${JSON.stringify(out)}`);
    return out.output.value as ToolOutcomeJson;
  };

  beforeAll(async () => {
    demo = await startDemo({ mode: 'bearer', token: TOKEN });
    const creds = new InMemoryCredentials({ 'secret://demo': TOKEN });
    provider = new McpToolProvider({
      target: target(demo.url, { auth: { strategy: 'HEADER', headerName: 'Authorization', tokenRef: 'secret://demo' } }),
      deps: deps(creds),
    });
  });
  afterAll(async () => {
    await provider.close();
    await demo.close();
  });

  it('serves /healthz without auth', async () => {
    const res = await fetch(`${demo.origin}/healthz`);
    expect(await res.json()).toEqual({ status: 'ok', server: { name: 'meridian-core', version: '0.1.0' } });
  });

  it('serves 2025-era clients too: v2 client in legacy mode and the v1 SDK client', async () => {
    const headers = { Authorization: `Bearer ${TOKEN}` };
    const legacy = new Client({ name: 'legacy-client', version: '1.0.0' });
    await legacy.connect(new StreamableHTTPClientTransport(new URL(demo.url), { requestInit: { headers } }));
    expect(legacy.getProtocolEra()).toBe('legacy');
    const result = await legacy.callTool({ name: 'crm.get_customer', arguments: { cif: '88214' } });
    expect(result.structuredContent).toMatchObject({ name: 'Priya Deshmukh', segment: 'Priority' });
    await legacy.close();

    const v1 = new V1Client({ name: 'v1-client', version: '1.30.0' });
    // v1 SDK typings predate exactOptionalPropertyTypes.
    await v1.connect(new V1Transport(new URL(demo.url), { requestInit: { headers } }) as unknown as Parameters<V1Client['connect']>[0]);
    const { tools } = await v1.listTools();
    expect(tools).toHaveLength(7);
    await v1.close();
  });

  it('returns Priya’s profile and EMI schedule consistent with the design', async () => {
    const profile = await run('crm.get_customer', { cif: '88214' });
    expect(profile).toMatchObject({
      cif: '88214',
      name: 'Priya Deshmukh',
      segment: 'Priority',
      customerSince: 2019,
      cards: [{ product: 'Meridian Signature', last4: '4417', creditLimit: '₹4,50,000', used: '₹1,12,400' }],
    });
    const schedule = await run('emi.get_schedule', { cif: '88214', planId: 'EMI-88214-01' });
    const plan = (schedule['plans'] as Array<{ instalments: Array<{ number: number; status: string; dueDate: string }>; nextDueDate: string }>)[0];
    expect(plan?.nextDueDate).toBe('2026-04-14');
    expect(plan?.instalments[3]).toMatchObject({ number: 4, status: 'PAID', dueDate: '2026-03-14' });
    expect(plan?.instalments[4]).toMatchObject({ number: 5, status: 'DUE', dueDate: '2026-04-14' });
  });

  it('lists 34 deterministic transactions with the duplicate ₹12,480 EMI pair', async () => {
    const a = await run('cards.list_transactions', { cif: '88214' });
    const b = await run('cards.list_transactions', { cif: '88214' });
    expect(a).toEqual(b);
    expect(a).toMatchObject({ window: { from: '2026-03-01', to: '2026-03-18' }, count: 34, returned: 34 });
    const txns = a['transactions'] as Array<{ txnId: string; amountMinor: number; description: string }>;
    expect(txns.find((t) => t.txnId === 'TXN-8841-2290')).toMatchObject({ amountMinor: 1_248_000, description: 'EMI 4/9 CROMA KALYANI NAGAR' });
    expect(a['duplicateCandidates']).toEqual([
      { txnIds: ['TXN-8841-2289', 'TXN-8841-2290'], amountMinor: 1_248_000, amount: '₹12,480', merchant: 'Croma Kalyani Nagar', valueDate: '2026-03-14', reason: 'Same amount, merchant and value date' },
    ]);
  });

  it('finds the CRD-114 fee waiver policy', async () => {
    const r = await run('knowledge.search_policy', { query: 'fee waiver for duplicate EMI' });
    expect((r['results'] as Array<{ policyId: string }>)[0]?.policyId).toBe('CRD-114');
  });

  it('write tools: statements dedupe naturally, disputes get ids, reversals return RVSL references once', async () => {
    const s1 = await run('statements.send_pdf', { cif: '88214', cardLast4: '4417', month: '2026-02', channel: 'WHATSAPP' });
    const s2 = await run('statements.send_pdf', { cif: '88214', cardLast4: '4417', month: '2026-02', channel: 'WHATSAPP' });
    expect(s1).toMatchObject({ deliveryId: 'STMT-7730001', replayed: false, destinationMasked: '+91 98•••41208' });
    expect(s2).toMatchObject({ deliveryId: 'STMT-7730001', replayed: true });

    const d = await run('disputes.raise_case', { cif: '88214', txnId: 'TXN-8841-2290', reason: 'DUPLICATE', description: 'Duplicate terminal auth' }, 'k-dispute');
    expect(d).toMatchObject({ caseId: 'DSP-20260318-001', status: 'OPEN', slaDueDate: '2026-03-27' });
    const profile = await run('crm.get_customer', { cif: '88214' });
    expect(profile['openDisputes']).toEqual([{ caseId: 'DSP-20260318-001', txnId: 'TXN-8841-2290', status: 'OPEN' }]);

    const r = await run('payments.reverse_transaction', { cif: '88214', txnId: 'TXN-8841-2290', amountMinor: 1_248_000, reason: 'Duplicate EMI' }, 'k-rev');
    expect(r).toMatchObject({ reference: 'RVSL-5521904', amount: '₹12,480', status: 'ACCEPTED' });
    const after = await run('cards.list_transactions', { cif: '88214' });
    expect(after['duplicateCandidates']).toEqual([]);
    expect((after['transactions'] as Array<{ txnId: string; status: string; reversalReference: string | null }>).find((t) => t.txnId === 'TXN-8841-2290')).toMatchObject({
      status: 'REVERSED',
      reversalReference: 'RVSL-5521904',
    });
  });

  it('verifies HS256 customer claims and formats rupees with Indian grouping', () => {
    expect(() => verifyClaims('a.b.c', 'secret', 0)).toThrow();
    expect(formatInr(45_000_000)).toBe('₹4,50,000');
    expect(formatInr(1_248_050)).toBe('₹12,480.50');
  });
});
