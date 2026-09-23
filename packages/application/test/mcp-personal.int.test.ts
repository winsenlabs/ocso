import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@ocso/db/testing';
import { uuidv7, virtualAgents } from '@ocso/db';
import type { Principal } from '@ocso/auth';
import { InMemorySecretRows, LocalSecretStore, parseMasterKey } from '@ocso/secrets';
import { AgentToolGrantService, McpConnectionService, PersonalConnectionService, sweepApprovalSecrets, type ActorContext, type ConnectionView } from '../src/index.js';
import { platformApprover, type PlatformApprover } from './support/platform-approvals.js';
import { startDemo, type DemoServer } from '../../mcp/test/helpers/demo-server.js';
import { createTeam, ownAgents } from './support/ownership.js';

const TOKEN = 'ops-desk-shared-bearer-token-771';
// Everyone but the Tech admin is in the team that owns Maya (ADR-026).
const TEAM = uuidv7();
const user = (role: Principal['role'], name: string): Principal => ({ userId: uuidv7(), role, displayName: name, teamIds: role === 'TECH' ? [] : [TEAM], via: 'UI' });
const admin = user('TECH', 'Tejas Shetty');
const lead = user('HEAD', 'Anjali Rao');
const ravi = user('SERVICE', 'Ravi Kumar');
const meera = user('SERVICE', 'Meera Iyer');
const actor = (p: Principal): ActorContext => ({ principal: p, correlationId: 'test-personal' });

let t: TestDatabase;
let demo: DemoServer;
let secrets: LocalSecretStore;
let svc: McpConnectionService;
let personal: PersonalConnectionService;
let template: ConnectionView;
let approver: PlatformApprover;
const agentId = uuidv7();

const q = async <T = Record<string, any>>(text: string, params: unknown[] = []) => (await t.pool.query(text, params)).rows as T[];

beforeAll(async () => {
  t = await createTestDatabase();
  for (const p of [admin, lead, ravi, meera]) {
    await t.pool.query(`INSERT INTO users (id, email, name, role) VALUES ($1, $2, $3, $4)`, [p.userId, `${p.userId}@x.test`, p.displayName, p.role]);
  }
  await t.pool.query(`UPDATE deployment_settings SET egress_allowed_internal_hosts = ARRAY['127.0.0.1']`);
  await t.db.insert(virtualAgents).values({ id: agentId, name: 'Maya', slug: 'maya', conversationType: 'SUPPORT' });
  await ownAgents(t.db, await createTeam(t.db, TEAM), agentId);
  secrets = new LocalSecretStore(new InMemorySecretRows(), parseMasterKey('k1', randomBytes(32).toString('base64')));
  svc = new McpConnectionService({ db: t.db, secrets, publicUrl: 'http://localhost:3000' });
  personal = new PersonalConnectionService(t.db);
  approver = await platformApprover(t.db, { secrets });
  demo = await startDemo({ mode: 'bearer', token: TOKEN });
});
afterAll(async () => {
  await demo?.close();
  await t?.drop();
});

describe('USER-scope templates and personal connections', () => {
  it('admin publishes a USER-scope template that is never offered to agents', async () => {
    template = await svc.createDraft(actor(admin), { name: 'ops-desk', url: demo.url, network: 'INTERNAL', scope: 'USER' });
    expect(template).toMatchObject({ kind: 'TEMPLATE', scope: 'USER', ownerUserId: null });
    expect(await personal.listTemplates(actor(ravi))).toEqual([]); // not published yet
    await svc.setHeaderAuth(actor(admin), template.id, { headerName: 'Authorization', token: TOKEN });
    const tools = await svc.listTools(actor(admin), template.id);
    const pick = (n: string) => tools.find((tool) => tool.name === n)!.id;
    await svc.classifyTools(actor(admin), template.id, {
      tools: [
        { toolId: pick('crm.get_customer'), riskClass: 'READ', approved: true },
        { toolId: pick('disputes.raise_case'), riskClass: 'WRITE', approved: true, humanRoles: ['SERVICE', 'HEAD'] },
      ],
    });
    await expect(svc.approve(actor(admin), template.id, { allowedAgentIds: '*' })).rejects.toMatchObject({ code: 'mcp_user_scope_agents' });
    await svc.approve(actor(admin), template.id, { allowedAgentIds: [] });
    // Publishing a template is an approval (deferred: the worker re-contacts the server).
    expect(await approver.finish((await approver.approve(actor(admin), 'mcp_connection', template.id, 'ACTIVATE')).id)).toBe('ACTIVATED');
    template = await svc.get(actor(admin), template.id);
    expect(template.status).toBe('ACTIVE');
    expect((await personal.listTemplates(actor(ravi))).map((c) => c.id)).toEqual([template.id]);
    expect(await svc.runDueHealthChecks()).toEqual([]); // templates are never probed
  });

  it('a user creates and authorizes their own instance; tools inherit the template approval', async () => {
    await expect(personal.create(actor(ravi), { templateId: uuidv7() })).rejects.toMatchObject({ code: 'mcp_connection_not_found' });
    const mine = await personal.create(actor(ravi), { templateId: template.id });
    expect(mine).toMatchObject({ kind: 'PERSONAL', ownerUserId: ravi.userId, templateId: template.id, status: 'PENDING', name: 'ops-desk', allowedAgentIds: [] });
    await expect(personal.create(actor(ravi), { templateId: template.id })).rejects.toMatchObject({ code: 'mcp_personal_connection_exists' });

    // Only the owner may use their credentials — not another exec, not even the Tech admin.
    await expect(svc.discover(actor(meera), mine.id)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(svc.setHeaderAuth(actor(admin), mine.id, { headerName: 'Authorization', token: TOKEN })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(svc.classifyTools(actor(admin), mine.id, { tools: [{ toolId: uuidv7(), riskClass: 'READ', approved: true }] })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(svc.get(actor(meera), mine.id)).rejects.toMatchObject({ code: 'forbidden' });
    expect((await svc.get(actor(admin), mine.id)).id).toBe(mine.id);

    expect((await svc.discover(actor(ravi), mine.id)).outcome).toBe('AUTH_REQUIRED');
    const found = await svc.setHeaderAuth(actor(ravi), mine.id, { headerName: 'Authorization', token: TOKEN });
    expect(found.connection).toMatchObject({ status: 'ACTIVE', approvedBy: ravi.userId, tools: { total: 7, approved: 2 } });
    const tools = await svc.listTools(actor(ravi), mine.id);
    expect(tools.filter((tool) => tool.approved).map((tool) => [tool.name, tool.riskClass])).toEqual([
      ['crm.get_customer', 'READ'],
      ['disputes.raise_case', 'WRITE'],
    ]);
    expect(tools[0]!.modelName).toMatch(/^ops-desk_u[0-9a-f]{8}__/);
    expect((await personal.listMine(actor(ravi))).map((c) => c.id)).toEqual([mine.id]);
    expect(await personal.listMine(actor(meera))).toEqual([]);

    // Personal tools are never grantable to virtual agents.
    const personalTool = tools.find((tool) => tool.name === 'crm.get_customer')!;
    await expect(new AgentToolGrantService(t.db).set(actor(lead), agentId, { grants: [{ toolId: personalTool.id }] })).rejects.toMatchObject({ code: 'tool_not_grantable' });

    // Re-classifying the (approved) template is an UPDATE proposal; once approved it propagates to every personal instance.
    const templateTools = await svc.listTools(actor(admin), template.id);
    await approver.approve(actor(admin), 'mcp_connection', template.id, 'UPDATE', {
      tools: [{ toolId: templateTools.find((tool) => tool.name === 'disputes.raise_case')!.id, riskClass: 'SENSITIVE', approved: false }],
    });
    const after = await svc.listTools(actor(ravi), mine.id);
    expect(after.find((tool) => tool.name === 'disputes.raise_case')).toMatchObject({ approved: false, riskClass: 'SENSITIVE' });

    expect(await svc.runDueHealthChecks()).toEqual([expect.objectContaining({ connectionId: mine.id, health: 'HEALTHY' })]);
    await expect(svc.checkHealth(actor(meera), mine.id)).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('owners delete their instance; deleting a template removes every instance and revokes their secrets', async () => {
    const [ravisConn] = await personal.listMine(actor(ravi));
    const meeras = await personal.create(actor(meera), { templateId: template.id });
    const authed = await svc.setHeaderAuth(actor(meera), meeras.id, { headerName: 'Authorization', token: TOKEN });
    const meeraRef = authed.connection.auth.tokenRef!;

    await expect(svc.delete(actor(ravi), meeras.id)).rejects.toMatchObject({ code: 'forbidden' });
    await svc.delete(actor(ravi), ravisConn!.id);
    expect(await secrets.describe(ravisConn!.auth.tokenRef!)).toBeNull();
    expect(await q(`SELECT 1 FROM mcp_connections WHERE id = $1`, [ravisConn!.id])).toHaveLength(0);

    // Deleting a shared template is an approval; its secrets (and every instance's) go after it commits.
    await expect(svc.delete(actor(admin), template.id)).rejects.toMatchObject({ code: 'approval_required' });
    await approver.approve(actor(admin), 'mcp_connection', template.id, 'DELETE');
    expect(await q(`SELECT 1 FROM mcp_connections WHERE id = ANY($1::uuid[])`, [[template.id, meeras.id]])).toHaveLength(0);
    await sweepApprovalSecrets(t.db, secrets);
    expect(await secrets.describe(meeraRef)).toBeNull();
    expect(await secrets.describe(template.auth.tokenRef!)).toBeNull();
  });
});
