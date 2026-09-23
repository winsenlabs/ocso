import { randomBytes } from 'node:crypto';
import type http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Principal } from '@ocso/auth';
import { McpConnectionService, SettingsService, type ActorContext } from '@ocso/application';
import { McpToolProviderFactory } from '@ocso/bootstrap';
import { uuidv7 } from '@ocso/db';
import { createTestDatabase, type TestDatabase } from '@ocso/db/testing';
import { InMemorySecretRows, LocalSecretStore, parseMasterKey } from '@ocso/secrets';

/** The demo MCP server lives with @ocso/mcp's tests (outside this tsconfig's rootDir): load it at runtime. */
interface DemoServer {
  url: string;
  server: http.Server;
  close(): Promise<void>;
}
async function startDemo(auth: Record<string, unknown>): Promise<DemoServer> {
  const helper = new URL('../../../../packages/mcp/test/helpers/demo-server.ts', import.meta.url);
  const mod = (await import(helper.href)) as { startDemo(a: Record<string, unknown>): Promise<DemoServer> };
  return mod.startDemo(auth);
}

const TOKEN = 'runtime-factory-bearer-token-42';
const admin: Principal = { userId: uuidv7(), role: 'TECH', displayName: 'Admin', teamIds: [], via: 'UI' };
const actor: ActorContext = { principal: admin, correlationId: 'test-factory' };
const call = (claims?: string) => ({ toolCallId: uuidv7(), toolName: 'crm.get_customer', args: { cif: '88214' }, timeoutMs: 5_000, ...(claims ? { customerClaims: claims } : {}) });

let t: TestDatabase;
let demo: DemoServer;
let secrets: LocalSecretStore;
let svc: McpConnectionService;
let factory: McpToolProviderFactory;
let connectionId: string;
const seenClaims: Array<string | undefined> = [];

beforeAll(async () => {
  t = await createTestDatabase();
  await t.pool.query(`INSERT INTO users (id, email, name, role) VALUES ($1, 'admin@x.test', 'Admin', 'TECH')`, [admin.userId]);
  await t.pool.query(`UPDATE deployment_settings SET egress_allowed_internal_hosts = ARRAY['127.0.0.1']`);
  secrets = new LocalSecretStore(new InMemorySecretRows(), parseMasterKey('k1', randomBytes(32).toString('base64')));
  svc = new McpConnectionService({ db: t.db, secrets, publicUrl: 'http://localhost:3000' });
  demo = await startDemo({ mode: 'bearer', token: TOKEN });
  // Record the customer-claims header each MCP POST carries.
  const listeners = demo.server.listeners('request') as http.RequestListener[];
  demo.server.removeAllListeners('request');
  demo.server.on('request', (req, res) => {
    if (req.method === 'POST' && String(req.headers['mcp-method'] ?? '') === 'tools/call') seenClaims.push(req.headers['x-ocso-customer-claims'] as string | undefined);
    for (const l of listeners) l.call(demo.server, req, res);
  });

  const conn = await svc.createDraft(actor, { name: 'core', url: demo.url, network: 'INTERNAL' });
  connectionId = conn.id;
  await svc.setHeaderAuth(actor, connectionId, { headerName: 'Authorization', token: TOKEN });
  const tool = (await svc.listTools(actor, connectionId)).find((x) => x.name === 'crm.get_customer')!;
  await svc.classifyTools(actor, connectionId, { tools: [{ toolId: tool.id, riskClass: 'READ', approved: true }] });
  await svc.approve(actor, connectionId, { allowedAgentIds: '*', sendCustomerClaims: true });
  factory = new McpToolProviderFactory(t.db, secrets, new SettingsService(t.db), { settingsTtlMs: 0, closeGraceMs: 10 });
});
afterAll(async () => {
  await factory?.close();
  await demo?.close();
  await t?.drop();
});

describe('McpToolProviderFactory', () => {
  it('pools one provider per connection and invokes tools with credentials from the SecretStore', async () => {
    const providers = await Promise.all(Array.from({ length: 5 }, () => factory.forConnection(connectionId)));
    expect(new Set(providers).size).toBe(1);
    const outcome = await providers[0]!.invoke(call('claims.jwt.sig'));
    expect(outcome).toMatchObject({ status: 'SUCCEEDED', output: { type: 'json', value: { name: 'Priya Deshmukh' } } });
    expect(seenClaims.at(-1)).toBe('claims.jwt.sig'); // trusted = sendCustomerClaims
    await expect(factory.forConnection(uuidv7())).rejects.toMatchObject({ code: 'mcp_connection_not_found' });
  });

  it('rebuilds the provider when the connection changes (updatedAt) and drops claims for untrusted connections', async () => {
    const before = await factory.forConnection(connectionId);
    await svc.approve(actor, connectionId, { allowedAgentIds: '*', sendCustomerClaims: false });
    const after = await factory.forConnection(connectionId);
    expect(after).not.toBe(before);
    expect(await factory.forConnection(connectionId)).toBe(after);
    expect((await after.invoke(call('claims.jwt.sig'))).status).toBe('SUCCEEDED');
    expect(seenClaims.at(-1)).toBeUndefined();
  });

  it('flags the connection AUTH_REQUIRED when the server rejects the stored credentials', async () => {
    const [row] = (await t.pool.query(`SELECT token_ref FROM mcp_connections WHERE id = $1`, [connectionId])).rows as Array<{ token_ref: string }>;
    await secrets.rotate(row!.token_ref, 'revoked-token-value');
    factory.invalidate(connectionId);
    const outcome = await (await factory.forConnection(connectionId)).invoke(call());
    expect(outcome).toMatchObject({ status: 'FAILED', errorCategory: 'tool_unavailable' });
    expect(JSON.stringify(outcome)).not.toContain('revoked-token-value');
    let status = '';
    for (let i = 0; i < 50 && status !== 'AUTH_REQUIRED'; i++) {
      await new Promise((r) => setTimeout(r, 20));
      status = ((await t.pool.query(`SELECT status FROM mcp_connections WHERE id = $1`, [connectionId])).rows[0] as { status: string }).status;
    }
    expect(status).toBe('AUTH_REQUIRED');
  });
});
