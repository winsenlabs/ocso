import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { McpAuthRequiredError, McpConnectionError, McpDiscoveryService, EgressBlockedError } from '../src/index.js';
import { startDemo, type DemoServer } from './helpers/demo-server.js';
import { deps, InMemoryCredentials, target } from './helpers/fixtures.js';

const TOKEN = 'meridian-demo-token-0123456789';

describe('discovery against the Meridian demo server', () => {
  let open: DemoServer;
  let bearer: DemoServer;

  beforeAll(async () => {
    open = await startDemo({ mode: 'none' });
    bearer = await startDemo({ mode: 'bearer', token: TOKEN });
  });
  afterAll(async () => {
    await open.close();
    await bearer.close();
  });

  it('discovers server info and the full normalized tool catalogue without auth (2026 era)', async () => {
    const result = await new McpDiscoveryService(deps()).discover(target(open.url));
    expect(result.serverName).toBe('meridian-core');
    expect(result.protocolEra).toBe('modern');
    expect(result.protocolVersion).toBe('2026-07-28');
    expect(result.capabilities).toHaveProperty('tools');
    expect(result.tools.map((t) => t.name)).toEqual([
      'cards.list_transactions',
      'crm.get_customer',
      'disputes.raise_case',
      'emi.get_schedule',
      'knowledge.search_policy',
      'payments.reverse_transaction',
      'statements.send_pdf',
    ]);
    const byName = new Map(result.tools.map((t) => [t.name, t]));
    expect(byName.get('crm.get_customer')?.suggestedRisk).toBe('READ');
    expect(byName.get('disputes.raise_case')?.suggestedRisk).toBe('WRITE');
    expect(byName.get('payments.reverse_transaction')?.suggestedRisk).toBe('SENSITIVE');
    expect(byName.get('statements.send_pdf')?.annotations).toMatchObject({ idempotentHint: true, destructiveHint: false });
    expect(byName.get('cards.list_transactions')?.modelName).toBe('meridian-core__cards_list_transactions');
    const reverse = byName.get('payments.reverse_transaction');
    expect(reverse?.inputSchema).toMatchObject({ type: 'object', required: expect.arrayContaining(['cif', 'txnId', 'amountMinor']) });
    expect(reverse?.outputSchema).toMatchObject({ type: 'object' });
    expect(reverse?.schemaHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.toolSetHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('is deterministic: hashes are stable across runs', async () => {
    const svc = new McpDiscoveryService(deps());
    const [a, b] = [await svc.discover(target(open.url)), await svc.discover(target(open.url))];
    expect(a.toolSetHash).toBe(b.toolSetHash);
    expect(a.tools.map((t) => t.schemaHash)).toEqual(b.tools.map((t) => t.schemaHash));
  });

  it('authenticates with a static header token resolved through the CredentialPort', async () => {
    const creds = new InMemoryCredentials({ 'secret://meridian': TOKEN });
    const result = await new McpDiscoveryService(deps(creds)).discover(
      target(bearer.url, { auth: { strategy: 'HEADER', headerName: 'Authorization', tokenRef: 'secret://meridian' } }),
    );
    expect(result.tools).toHaveLength(7);
    expect(creds.resolveCalls).toBeGreaterThan(0);
  });

  it('reports McpAuthRequired (no OAuth metadata) when a bearer server is called without credentials', async () => {
    const err = await new McpDiscoveryService(deps()).discover(target(bearer.url)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpAuthRequiredError);
    const info = (err as McpAuthRequiredError).authRequired;
    expect(info.reason).toBe('unauthorized');
    expect(info.oauthAvailable).toBe(false);
    expect(info.authorizationServers).toEqual([]);
  });

  it('reports token_rejected for a wrong header token and never leaks the token', async () => {
    const creds = new InMemoryCredentials({ 'secret://meridian': 'wrong-token-value-xyz' });
    const err = await new McpDiscoveryService(deps(creds))
      .discover(target(bearer.url, { auth: { strategy: 'HEADER', headerName: 'Authorization', tokenRef: 'secret://meridian' } }))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpAuthRequiredError);
    expect((err as McpAuthRequiredError).authRequired.reason).toBe('token_rejected');
    expect(JSON.stringify({ m: (err as Error).message, d: (err as McpAuthRequiredError).details })).not.toContain('wrong-token-value-xyz');
  });

  it('reports credentials_missing when the secret reference cannot be resolved', async () => {
    const err = await new McpDiscoveryService(deps())
      .discover(target(bearer.url, { auth: { strategy: 'HEADER', headerName: 'X-API-Key', tokenRef: 'secret://missing' } }))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpAuthRequiredError);
    expect((err as McpAuthRequiredError).authRequired.reason).toBe('credentials_missing');
  });

  it('refuses a loopback server unless the connection is INTERNAL and the host is allowlisted', async () => {
    const svc = new McpDiscoveryService(deps());
    await expect(svc.discover(target(open.url, { network: 'PUBLIC' }))).rejects.toBeInstanceOf(EgressBlockedError);
    const strict = new McpDiscoveryService(deps(undefined, { allowedInternalHosts: [], allowInsecureHttpHosts: ['127.0.0.1'] }));
    await expect(strict.discover(target(open.url))).rejects.toMatchObject({ reason: 'private_address' });
  });

  it('maps an unreachable server to a typed connection error', async () => {
    const dead = await startDemo();
    const url = dead.url;
    await dead.close();
    const err = await new McpDiscoveryService(deps()).discover(target(url), { timeoutMs: 3_000 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpConnectionError);
    expect((err as McpConnectionError).failure).toBe('unreachable');
  });
});
