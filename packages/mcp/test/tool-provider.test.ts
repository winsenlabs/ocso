import { createHash, createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as z from 'zod';
import { McpToolProvider, type McpConnectionTarget, type McpToolProviderOptions } from '../src/index.js';
import { startV2Server, startStatusServer, type McpTestServer } from './helpers/custom-servers.js';
import { startDemo, type DemoServer } from './helpers/demo-server.js';
import { deps, InMemoryCredentials, target } from './helpers/fixtures.js';

const TOKEN = 'meridian-demo-token-0123456789';
const CLAIMS_SECRET = 'claims-signing-secret';

function claimsFor(sub: string): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const body = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub, exp: Math.floor(Date.now() / 1000) + 300 })}`;
  return `${body}.${createHmac('sha256', CLAIMS_SECRET).update(body).digest('base64url')}`;
}

const call = (toolName: string, args: unknown, extra: Partial<Parameters<McpToolProvider['invoke']>[0]> = {}) => ({
  toolCallId: `call-${toolName}`,
  toolName,
  args,
  timeoutMs: 5_000,
  ...extra,
});

describe('McpToolProvider', () => {
  let demo: DemoServer;
  let custom: McpTestServer;
  const providers: McpToolProvider[] = [];
  const provider = (t: McpConnectionTarget, extra: Partial<McpToolProviderOptions> = {}, creds = new InMemoryCredentials()) => {
    const p = new McpToolProvider({ target: t, deps: deps(creds), ...extra });
    providers.push(p);
    return p;
  };

  beforeAll(async () => {
    demo = await startDemo({ mode: 'bearer', token: TOKEN }, CLAIMS_SECRET);
    custom = await startV2Server((server) => {
      server.registerTool('text_only', { description: 'two text blocks', inputSchema: z.object({}) }, async () => ({
        content: [
          { type: 'text', text: 'line one' },
          { type: 'text', text: 'line two' },
        ],
      }));
      server.registerTool('slow', { inputSchema: z.object({ ms: z.number() }) }, async ({ ms }) => {
        await new Promise((r) => setTimeout(r, ms));
        return { content: [{ type: 'text', text: 'late' }] };
      });
      server.registerTool('echo_identity', { inputSchema: z.object({}) }, async (_args, ctx) => {
        const digest = (v: string | null | undefined) => (v ? createHash('sha256').update(v).digest('hex') : 'none');
        return { content: [{ type: 'text', text: 'ok' }], structuredContent: { auth: digest(ctx.http?.req?.headers.get('authorization')), user: digest(ctx.http?.req?.headers.get('x-ocso-user-token')), marker: digest(ctx.http?.req?.headers.get('x-ocso-user-bearer')) } };
      });
      server.registerTool('echo_auth', { inputSchema: z.object({ fail: z.boolean() }) }, async ({ fail }, ctx) => {
        const seen = ctx.http?.req?.headers.get('authorization') ?? 'none';
        return fail
          ? { isError: true, content: [{ type: 'text', text: `rejected credential ${seen}` }] }
          : { content: [{ type: 'text', text: seen }], structuredContent: { seen, nested: [{ seen }] } };
      });
    });
  });
  afterAll(async () => {
    await Promise.all(providers.map((p) => p.close()));
    await demo.close();
    await custom.close();
  });

  const bearerTarget = () => target(demo.url, { auth: { strategy: 'HEADER', headerName: 'Authorization', tokenRef: 'secret://t' } });
  const bearerCreds = () => new InMemoryCredentials({ 'secret://t': TOKEN });

  it('maps structuredContent to a json outcome and reuses one negotiated client', async () => {
    const creds = bearerCreds();
    const p = provider(bearerTarget(), {}, creds);
    const first = await p.invoke(call('cards.list_transactions', { cif: '88214' }));
    expect(first.status).toBe('SUCCEEDED');
    if (first.status !== 'SUCCEEDED' || first.output.type !== 'json') throw new Error('expected json');
    const value = first.output.value as { count: number; duplicateCandidates: Array<{ txnIds: string[]; amount: string }> };
    expect(value.count).toBe(34);
    expect(value.duplicateCandidates).toEqual([expect.objectContaining({ txnIds: ['TXN-8841-2289', 'TXN-8841-2290'], amount: '₹12,480' })]);
    await p.invoke(call('emi.get_schedule', { cif: '88214' }));
    expect(creds.resolveCalls).toBe(1);
  });

  it('joins text content when there is no structuredContent', async () => {
    const out = await provider(target(custom.url)).invoke(call('text_only', {}));
    expect(out).toMatchObject({ status: 'SUCCEEDED', output: { type: 'text', value: 'line one\nline two' } });
  });

  it('maps isError to FAILED tool_rejected with the tool’s (sanitized) message', async () => {
    const out = await provider(bearerTarget(), {}, bearerCreds()).invoke(call('crm.get_customer', { cif: '99999' }));
    expect(out).toMatchObject({ status: 'FAILED', errorCategory: 'tool_rejected', message: 'The tool reported an error: No customer with CIF 99999.' });
  });

  it('maps server-side argument validation failures to validation, and rejects non-object args locally', async () => {
    const p = provider(bearerTarget(), {}, bearerCreds());
    const bad = await p.invoke(call('crm.get_customer', { cif: 'not-a-cif' }));
    expect(bad).toMatchObject({ status: 'FAILED', errorCategory: 'validation', message: expect.stringContaining('Input validation error') });
    expect(await p.invoke(call('crm.get_customer', ['88214']))).toMatchObject({ status: 'FAILED', errorCategory: 'validation' });
    expect(await p.invoke(call('no.such_tool', {}))).toMatchObject({ status: 'FAILED', errorCategory: 'validation' });
  });

  it('enforces the admin-approved output schema', async () => {
    const p = provider(bearerTarget(), {
      approvedTool: (name) => ({ name, inputSchema: { type: 'object' }, outputSchema: { type: 'object', required: ['approvedField'] } }),
    }, bearerCreds());
    const out = await p.invoke(call('crm.get_customer', { cif: '88214' }));
    expect(out).toMatchObject({ status: 'FAILED', errorCategory: 'tool_rejected', message: 'The tool returned output that does not match its approved schema.' });
  });

  it('times out with a timeout outcome, and reports caller cancellation separately', async () => {
    const p = provider(target(custom.url));
    const t0 = Date.now();
    const slow = await p.invoke(call('slow', { ms: 3_000 }, { timeoutMs: 250 }));
    expect(slow).toMatchObject({ status: 'FAILED', errorCategory: 'timeout', message: 'The tool did not respond in time.' });
    expect(Date.now() - t0).toBeLessThan(2_000);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    const cancelled = await p.invoke(call('slow', { ms: 3_000 }, { signal: ac.signal }));
    expect(cancelled).toMatchObject({ status: 'FAILED', errorCategory: 'internal', message: 'The tool call was cancelled.' });
  });

  it('maps an unreachable server and HTTP 5xx to tool_unavailable with safe messages', async () => {
    const dead = await startDemo();
    await dead.close();
    const gone = await provider(target(dead.url)).invoke(call('crm.get_customer', { cif: '88214' }));
    expect(gone).toMatchObject({ status: 'FAILED', errorCategory: 'tool_unavailable', message: 'The tool server could not be reached.' });

    const broken = await startStatusServer(503);
    const out = await provider(target(broken.url)).invoke(call('crm.get_customer', { cif: '88214' }));
    expect(out).toMatchObject({ status: 'FAILED', errorCategory: 'tool_unavailable', message: 'The tool server is unavailable (HTTP 503).' });
    expect(JSON.stringify(out)).not.toContain('stack trace');
    await broken.close();
  });

  it('maps rejected credentials to tool_unavailable, notifies the caller, and never leaks the token', async () => {
    const failures: string[] = [];
    const creds = new InMemoryCredentials({ 'secret://t': 'wrong-secret-token-value' });
    const out = await provider(bearerTarget(), { onAuthFailure: (id) => failures.push(id) }, creds).invoke(call('crm.get_customer', { cif: '88214' }));
    expect(out).toMatchObject({ status: 'FAILED', errorCategory: 'tool_unavailable', message: 'The tool connection needs to be re-authorized by an administrator.' });
    expect(failures).toEqual(['conn-meridian']);
    expect(JSON.stringify(out)).not.toContain('wrong-secret-token-value');
  });

  it('refuses egress to a private host on a PUBLIC connection', async () => {
    const out = await provider(target(demo.url, { network: 'PUBLIC' })).invoke(call('crm.get_customer', { cif: '88214' }));
    expect(out).toMatchObject({ status: 'FAILED', errorCategory: 'tool_unavailable', message: 'The tool server is blocked by the outbound network policy.' });
  });

  it('redacts resolved credentials from tool output and tool error text', async () => {
    const creds = new InMemoryCredentials({ 'secret://t': 'echo-me-secret-123' });
    const t = target(custom.url, { auth: { strategy: 'HEADER', headerName: 'Authorization', tokenRef: 'secret://t' } });
    const p = provider(t, {}, creds);
    const ok = await p.invoke(call('echo_auth', { fail: false }));
    expect(JSON.stringify(ok)).not.toContain('echo-me-secret-123');
    expect(ok).toMatchObject({ output: { type: 'json', value: { seen: '[REDACTED]', nested: [{ seen: '[REDACTED]' }] } } });
    const failed = await p.invoke(call('echo_auth', { fail: true }));
    expect(failed).toMatchObject({ status: 'FAILED', errorCategory: 'tool_rejected' });
    expect(JSON.stringify(failed)).not.toContain('echo-me-secret-123');
  });

  it('sends Idempotency-Key per call so a retried write replays instead of acting twice', async () => {
    const p = provider(bearerTarget(), {}, bearerCreds());
    const args = { cif: '88214', txnId: 'TXN-8841-2290', amountMinor: 1_248_000, reason: 'Duplicate EMI authorisation' };
    const first = await p.invoke(call('payments.reverse_transaction', args, { idempotencyKey: 'conv_9f41ac:reverse:1' }));
    const retry = await p.invoke(call('payments.reverse_transaction', args, { idempotencyKey: 'conv_9f41ac:reverse:1' }));
    expect(first).toMatchObject({ status: 'SUCCEEDED', output: { value: { reference: 'RVSL-5521904', replayed: false, expectedCreditBy: '2026-03-23' } } });
    expect(retry).toMatchObject({ status: 'SUCCEEDED', output: { value: { reference: 'RVSL-5521904', replayed: true } } });
    const noKey = await p.invoke(call('payments.reverse_transaction', args));
    expect(noKey).toMatchObject({ status: 'FAILED', errorCategory: 'tool_rejected' });
    expect(await p.invoke(call('payments.reverse_transaction', args, { idempotencyKey: 'bad\r\nkey' }))).toMatchObject({ errorCategory: 'validation' });
  });

  it('sends customer claims only to trusted connections, per call', async () => {
    const wrongCustomer = claimsFor('90517');
    const untrusted = provider(bearerTarget(), {}, bearerCreds());
    expect(await untrusted.invoke(call('crm.get_customer', { cif: '88214' }, { customerClaims: wrongCustomer }))).toMatchObject({ status: 'SUCCEEDED' });
    const trusted = provider(bearerTarget(), { trusted: true }, bearerCreds());
    const denied = await trusted.invoke(call('crm.get_customer', { cif: '88214' }, { customerClaims: wrongCustomer }));
    expect(denied).toMatchObject({ status: 'FAILED', errorCategory: 'tool_rejected' });
    expect(JSON.stringify(denied)).not.toContain(wrongCustomer);
    const allowed = await trusted.invoke(call('crm.get_customer', { cif: '88214' }, { customerClaims: claimsFor('88214') }));
    expect(allowed).toMatchObject({ status: 'SUCCEEDED' });
  });

  it('forwards the customer user token only when the connection opted in: as the bearer without own auth, else in its own header', async () => {
    const sha = (v: string) => createHash('sha256').update(v).digest('hex');
    const USER = 'eyJ.customer-user-token.sig';
    const seen = async (p: McpToolProvider) => {
      const out = await p.invoke(call('echo_identity', {}, { userToken: USER }));
      if (out.status !== 'SUCCEEDED' || out.output.type !== 'json') throw new Error(`expected json, got ${JSON.stringify(out)}`);
      return out.output.value as { auth: string; user: string; marker: string };
    };
    expect(await seen(provider(target(custom.url)))).toEqual({ auth: 'none', user: 'none', marker: 'none' });
    expect(await seen(provider(target(custom.url), { forwardUserToken: true }))).toEqual({ auth: sha(`Bearer ${USER}`), user: 'none', marker: 'none' });
    const own = target(custom.url, { auth: { strategy: 'HEADER', headerName: 'Authorization', tokenRef: 'secret://svc' } });
    const creds = new InMemoryCredentials({ 'secret://svc': 'service-token-1' });
    expect(await seen(provider(own, { forwardUserToken: true }, creds))).toEqual({ auth: sha('Bearer service-token-1'), user: sha(USER), marker: 'none' });
    // Concurrent calls never share a token (per-request headers).
    const p = provider(target(custom.url), { forwardUserToken: true });
    const [a, b] = await Promise.all([p.invoke(call('echo_identity', {}, { userToken: 'user-a' })), p.invoke(call('echo_identity', {}, { userToken: 'user-b' }))]);
    expect([a, b].map((o) => (o.status === 'SUCCEEDED' && o.output.type === 'json' ? (o.output.value as { auth: string }).auth : null))).toEqual([sha('Bearer user-a'), sha('Bearer user-b')]);
  });
});
