import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { completeSetup, startApi, type ApiHarness } from './harness.js';

/**
 * The in-process demo MCP server and test authorization server live with
 * @ocso/mcp's tests. This tsconfig pins rootDir to apps/api, so they are
 * loaded at runtime (computed specifier) and typed structurally here.
 */
interface TestAuthServer {
  issuer: string;
  metadata: unknown;
  verifierFor(resource: URL): unknown;
  close(): Promise<void>;
}
interface DemoServer {
  url: string;
  close(): Promise<void>;
}
interface McpTestHelpers {
  startTestAuthServer(options: { expectedResource: () => string }): Promise<TestAuthServer>;
  startDemo(auth: (mcpUrl: URL) => Record<string, unknown>): Promise<DemoServer>;
}
async function loadMcpTestHelpers(): Promise<McpTestHelpers> {
  const dir = new URL('../../../../packages/mcp/test/helpers/', import.meta.url);
  const [auth, demo] = await Promise.all([import(new URL('auth-server.ts', dir).href), import(new URL('demo-server.ts', dir).href)]);
  return { startTestAuthServer: auth.startTestAuthServer, startDemo: demo.startDemo };
}

let h: ApiHarness;
let authServer: TestAuthServer;
let rs: DemoServer;
const tokens: Record<'admin' | 'lead' | 'exec', string> = { admin: '', lead: '', exec: '' };
const agentId = '0192f0c1-0000-7000-8000-00000000a001';
const teamId = '0192f0c1-0000-7000-8000-00000000a0f1';
let connectionId: string;

const bearer = (who: keyof typeof tokens) => ({ authorization: `Bearer ${tokens[who]}` });

/** Plays the admin's browser against the auto-approving AS; returns the path+query OCSO's callback receives. */
async function consent(authorizationUrl: string): Promise<string> {
  const res = await fetch(authorizationUrl, { redirect: 'manual' });
  const location = new URL(res.headers.get('location') ?? '');
  expect(location.pathname).toBe('/oauth/mcp/callback');
  return `${location.pathname}${location.search}`;
}

beforeAll(async () => {
  h = await startApi();
  tokens.admin = await completeSetup(h);
  for (const [who, role] of [['lead', 'CS_LEAD'], ['exec', 'CS_EXEC']] as const) {
    const password = `${who} password 1234`;
    await h.http().post('/v1/users').set(bearer('admin')).send({ email: `${who}@ocso.test`, name: who, role, password }).expect(201);
    tokens[who] = await h.loginAs(`${who}@ocso.test`, password);
  }
  await h.db.pool.query(`INSERT INTO virtual_agents (id, name, slug, conversation_type) VALUES ($1, 'Maya', 'maya', 'SUPPORT')`, [agentId]);
  // Lead and exec are in the team that owns Maya (ADR-026).
  await h.db.pool.query(`INSERT INTO teams (id, name) VALUES ($1, 'Cards')`, [teamId]);
  await h.db.pool.query(`INSERT INTO agent_teams (agent_id, team_id) VALUES ($1, $2)`, [agentId, teamId]);
  await h.db.pool.query(`INSERT INTO team_members (team_id, user_id) SELECT $1, id FROM users WHERE email IN ('lead@ocso.test', 'exec@ocso.test')`, [teamId]);
  await h.http().patch('/v1/settings/deployment').set(bearer('admin')).send({ egressAllowedInternalHosts: ['127.0.0.1'] }).expect(200);
  const { startTestAuthServer, startDemo } = await loadMcpTestHelpers();
  authServer = await startTestAuthServer({ expectedResource: () => rs.url });
  rs = await startDemo((mcpUrl) => ({
    mode: 'oauth',
    verifier: authServer.verifierFor(mcpUrl),
    oauthMetadata: authServer.metadata,
    resourceServerUrl: mcpUrl,
    scopesSupported: ['meridian:read', 'meridian:write'],
    allowInsecureIssuer: true,
  }));
});
afterAll(async () => {
  await rs?.close();
  await authServer?.close();
  await h?.close();
});

describe('MCP API', () => {
  it('enforces RBAC on connection routes and validates bodies', async () => {
    await h.http().get('/v1/mcp/connections').expect(401);
    await h.http().get('/v1/mcp/connections').set(bearer('exec')).expect(403);
    await h.http().get('/v1/mcp/connections').set(bearer('lead')).expect(200);
    const body = { name: 'bank-core', url: rs.url, network: 'INTERNAL' };
    await h.http().post('/v1/mcp/connections').set(bearer('lead')).send(body).expect(403);
    const bad = await h.http().post('/v1/mcp/connections').set(bearer('admin')).send({ ...body, name: 'Bank Core!' }).expect(400);
    expect(bad.body.error.category).toBe('validation');
    const created = await h.http().post('/v1/mcp/connections').set(bearer('admin')).send(body).expect(201);
    expect(created.body).toMatchObject({ name: 'bank-core', status: 'PENDING', stage: 'DISCOVER' });
    connectionId = created.body.id;
    await h.http().post(`/v1/mcp/connections/${connectionId}/discover`).set(bearer('lead')).expect(403);
    await h.http().get('/v1/mcp/connections/not-a-uuid').set(bearer('admin')).expect(400);
    await h.http().get(`/v1/mcp/connections/${crypto.randomUUID()}`).set(bearer('admin')).expect(404);
  });

  it('runs discovery → OAuth through the public callback, which validates state and never echoes tokens', async () => {
    const discovered = await h.http().post(`/v1/mcp/connections/${connectionId}/discover`).set(bearer('admin')).expect(200);
    expect(discovered.body).toMatchObject({ outcome: 'AUTH_REQUIRED', authRequired: { oauthAvailable: true } });
    await h.http().post(`/v1/mcp/connections/${connectionId}/oauth/begin`).set(bearer('exec')).send({}).expect(403);
    const begun = await h.http().post(`/v1/mcp/connections/${connectionId}/oauth/begin`).set(bearer('admin')).send({}).expect(200);
    const callbackPath = await consent(begun.body.authorizationUrl);
    const code = new URLSearchParams(callbackPath.split('?')[1]).get('code')!;

    const forged = await h.http().get(`/oauth/mcp/callback?code=${encodeURIComponent(code)}&state=forged`).expect(302);
    expect(forged.headers['location']).toBe('http://localhost:3000/connections?tab=mcp&oauth=error&reason=state_mismatch');

    const ok = await h.http().get(callbackPath).expect(302);
    expect(ok.headers['location']).toBe(`http://localhost:3000/connections?tab=mcp&connection=${connectionId}&oauth=ok`);
    expect(ok.headers['cache-control']).toBe('no-store');
    expect(ok.headers['referrer-policy']).toBe('no-referrer');
    expect(ok.headers['location']).not.toContain(code);

    const replay = await h.http().get(callbackPath).expect(302);
    expect(replay.headers['location']).toContain('oauth=error&reason=state_mismatch');
    const noState = await h.http().get('/oauth/mcp/callback?error=access_denied').expect(302);
    expect(noState.headers['location']).toContain('oauth=error&reason=state_mismatch');

    const conn = await h.http().get(`/v1/mcp/connections/${connectionId}`).set(bearer('lead')).expect(200);
    expect(conn.body).toMatchObject({ status: 'PENDING', stage: 'REVIEW', auth: { strategy: 'OAUTH', issuer: authServer.issuer }, tools: { total: 7 } });
    expect(JSON.stringify(conn.body)).not.toMatch(/"at_|"rt_/);
  });

  it('reviews, approves and grants tools to an agent with role-appropriate permissions', async () => {
    const tools = await h.http().get(`/v1/mcp/connections/${connectionId}/tools`).set(bearer('lead')).expect(200);
    const getCustomer = tools.body.find((t: { name: string }) => t.name === 'crm.get_customer');
    const classify = { tools: [{ toolId: getCustomer.id, riskClass: 'READ', approved: true }] };
    await h.http().put(`/v1/mcp/connections/${connectionId}/tools`).set(bearer('lead')).send(classify).expect(403);
    await h.http().put(`/v1/mcp/connections/${connectionId}/tools`).set(bearer('admin')).send(classify).expect(200);
    const approved = await h.http().post(`/v1/mcp/connections/${connectionId}/approve`).set(bearer('admin')).send({ allowedAgentIds: [agentId] }).expect(200);
    expect(approved.body).toMatchObject({ status: 'ACTIVE', allowedAgentIds: [agentId] });

    const grant = { grants: [{ toolId: getCustomer.id, argumentRules: [{ path: 'cif', op: 'exists', effect: 'REQUIRE_CONFIRMATION', message: 'confirm lookups' }] }] };
    await h.http().put(`/v1/agents/${agentId}/tools`).set(bearer('admin')).send(grant).expect(403);
    const badRule = { grants: [{ toolId: getCustomer.id, argumentRules: [{ path: 'cif', op: 'gt', value: 'x', effect: 'DENY', message: 'm' }] }] };
    await h.http().put(`/v1/agents/${agentId}/tools`).set(bearer('lead')).send(badRule).expect(400);
    const set = await h.http().put(`/v1/agents/${agentId}/tools`).set(bearer('lead')).send(grant).expect(200);
    expect(set.body.tools).toEqual([expect.objectContaining({ toolId: getCustomer.id, eligible: true, grant: expect.objectContaining({ enabled: true }) })]);
    await h.http().get(`/v1/agents/${agentId}/tools`).set(bearer('exec')).expect(200);
    await h.http().put(`/v1/agents/${crypto.randomUUID()}/tools`).set(bearer('lead')).send({ grants: [] }).expect(404);

    const health = await h.http().post(`/v1/mcp/connections/${connectionId}/health`).set(bearer('admin')).expect(200);
    expect(health.body).toMatchObject({ health: 'HEALTHY', status: 'ACTIVE' });
    const history = await h.http().get(`/v1/mcp/connections/${connectionId}/health?limit=5`).set(bearer('lead')).expect(200);
    expect(history.body).toHaveLength(1);
  });

  it('personal connections are open to every role with mcp.connect_personal, and disable/delete stay admin-only', async () => {
    expect((await h.http().get('/v1/mcp/personal/templates').set(bearer('exec')).expect(200)).body).toEqual([]);
    expect((await h.http().get('/v1/mcp/personal').set(bearer('exec')).expect(200)).body).toEqual([]);
    const notTemplate = await h.http().post('/v1/mcp/personal').set(bearer('exec')).send({ templateId: connectionId }).expect(400);
    expect(notTemplate.body.error.code).toBe('mcp_not_a_template');

    await h.http().post(`/v1/mcp/connections/${connectionId}/disable`).set(bearer('lead')).expect(403);
    expect((await h.http().post(`/v1/mcp/connections/${connectionId}/disable`).set(bearer('admin')).expect(200)).body.status).toBe('DISABLED');
    await h.http().delete(`/v1/mcp/connections/${connectionId}`).set(bearer('exec')).expect(403);
    await h.http().delete(`/v1/mcp/connections/${connectionId}`).set(bearer('admin')).expect(204);
    await h.http().get(`/v1/mcp/connections/${connectionId}`).set(bearer('admin')).expect(404);
  });
});
