import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Principal } from '@ocso/auth';
import { approvalProposals, auditEvents, mcpConnections, uuidv7 } from '@ocso/db';
import { createTestDatabase, type TestDatabase } from '@ocso/db/testing';
import { InMemorySecretRows, LocalSecretStore, parseMasterKey } from '@ocso/secrets';
import { McpConnectionService, assertOAuthAllowed, isApproved, proposalContentHash, systemActor, type ActorContext } from '../../src/index.js';
import { startV2Server, type McpTestServer } from '../../../mcp/test/helpers/custom-servers.js';
import { ensureUser, platformApprover, type PlatformApprover } from '../support/platform-approvals.js';

/**
 * A shared MCP connection's go-live is DEFERRED (the worker re-contacts the server). What must hold between
 * the approval and that finish (PM/research/11b "Deferred activation", wave 2 COVERAGE-PLATFORM):
 * - a tool set that changed since review blocks it (compared with the snapshot the checker approved);
 * - a disable in between (a stop) is never undone by the activation;
 * - a crash after the go-live committed but before the spine's stamp finishes as ACTIVATED on redelivery;
 * - OAuth on a governed connection is only a re-authorization; anything else is a proposal;
 * - a header credential in a payload must be one staged for that connection by that maker.
 */

let t: TestDatabase;
let secrets: LocalSecretStore;
let svc: McpConnectionService;
let approver: PlatformApprover;
let server: McpTestServer;
let variant = 1;
const tech: Principal = { userId: uuidv7(), role: 'TECH', displayName: 'Tarun Tech', teamIds: [], via: 'UI' };
const admin: ActorContext = { principal: tech, correlationId: 'mcp-activation' };
const row = async (id: string) => (await t.db.select().from(mcpConnections).where(eq(mcpConnections.id, id)))[0]!;

beforeAll(async () => {
  t = await createTestDatabase();
  await ensureUser(t.db, tech);
  await t.pool.query(`UPDATE deployment_settings SET egress_allowed_internal_hosts = ARRAY['127.0.0.1']`);
  secrets = new LocalSecretStore(new InMemorySecretRows(), parseMasterKey('k1', randomBytes(32).toString('base64')));
  svc = new McpConnectionService({ db: t.db, secrets, publicUrl: 'http://localhost:3000' });
  approver = await platformApprover(t.db, { secrets });
  server = await startV2Server((s) => {
    s.registerTool('lookup', { description: 'Look up an account', inputSchema: z.object({ id: z.string() }), annotations: { readOnlyHint: true } }, async () => ({ content: [{ type: 'text', text: 'ok' }] }));
    if (variant === 2) s.registerTool('wire_money', { description: 'Send a payment', inputSchema: z.object({ to: z.string() }) }, async () => ({ content: [] }));
  });
});
afterAll(async () => {
  await server?.close();
  await t?.drop();
});

/** A reviewed draft ready to go live: discovered, its tool approved, a policy recorded. */
async function readyDraft(name: string): Promise<string> {
  variant = 1;
  const draft = await svc.createDraft(admin, { name, url: server.url, network: 'INTERNAL' });
  expect((await svc.discover(admin, draft.id)).outcome).toBe('DISCOVERED');
  const tools = await svc.listTools(admin, draft.id);
  await svc.classifyTools(admin, draft.id, { tools: tools.map((tool) => ({ toolId: tool.id, riskClass: 'READ' as const, approved: true })) });
  await svc.approve(admin, draft.id, { allowedAgentIds: '*' });
  return draft.id;
}

describe('deferred activation', () => {
  it('blocks when the server’s tools changed after the checker reviewed them', async () => {
    const id = await readyDraft('changed-tools');
    const proposal = await approver.approve(admin, 'mcp_connection', id, 'ACTIVATE');
    variant = 2;
    expect(await approver.finish(proposal.id)).toBe('BLOCKED');
    const [p] = await t.db.select().from(approvalProposals).where(eq(approvalProposals.id, proposal.id));
    expect(p!.blockedReason).toMatch(/tools changed since they were reviewed/);
    expect((await row(id)).approvedAt).toBeNull();
    variant = 1;
  });

  it('a disable between the approval and the finish wins: the connection stays disabled', async () => {
    const id = await readyDraft('stopped-in-between');
    const proposal = await approver.approve(admin, 'mcp_connection', id, 'ACTIVATE');
    expect((await svc.disable(admin, id)).status).toBe('DISABLED');
    expect(await approver.finish(proposal.id)).toBe('BLOCKED');
    const [p] = await t.db.select().from(approvalProposals).where(eq(approvalProposals.id, proposal.id));
    expect(p!.blockedReason).toMatch(/disabled after this activation was submitted/);
    expect(await row(id)).toMatchObject({ status: 'DISABLED', approvedAt: null });
  });

  it('a crash after the go-live committed (before the stamp) finishes as ACTIVATED on redelivery', async () => {
    const id = await readyDraft('crash-after-commit');
    const proposal = await approver.approve(admin, 'mcp_connection', id, 'ACTIVATE');
    const [p] = await t.db.select().from(approvalProposals).where(eq(approvalProposals.id, proposal.id));
    // The worker's first attempt: the go-live commits, then the process dies before the spine stamps it.
    await approver.approvals['registry'].get('mcp_connection').activateDeferred!(t.db, systemActor('test', 'crash'), p!);
    expect((await row(id)).status).toBe('ACTIVE');
    expect(await isApproved(t.db, 'mcp_connection', id)).toBe(true);
    variant = 2; // even a changed server now: the approved change is already live
    expect(await approver.finish(proposal.id)).toBe('ACTIVATED');
    variant = 1;
    const [stamped] = await t.db.select().from(approvalProposals).where(eq(approvalProposals.id, proposal.id));
    expect(stamped).toMatchObject({ status: 'APPROVED' });
    expect(stamped!.activatedAt).toBeInstanceOf(Date);
    await expect(svc.approve(admin, id, { allowedAgentIds: [] })).rejects.toMatchObject({ code: 'approval_required' });
  });
});

describe('proposals submitted before forwardUserToken existed (upgrade)', () => {
  /** Rewrite a proposal as the previous release stored it: a before-snapshot without forwardUserToken, hashed over that. */
  async function asPreUpgrade(proposalId: string): Promise<string> {
    const [p] = await t.db.select().from(approvalProposals).where(eq(approvalProposals.id, proposalId));
    const { forwardUserToken: _dropped, ...before } = p!.beforeSnapshot as Record<string, unknown>;
    const contentHash = proposalContentHash({ ...p!, payload: p!.payload as Record<string, unknown>, beforeSnapshot: before }, ['status']);
    await t.db.update(approvalProposals).set({ beforeSnapshot: before, contentHash }).where(eq(approvalProposals.id, proposalId));
    return contentHash;
  }

  it('an open ACTIVATE hashed without the field can still be approved and goes live', async () => {
    const id = await readyDraft('pre-upgrade-open');
    const open = await approver.submit(admin, 'mcp_connection', id, 'ACTIVATE');
    expect(open.before).not.toHaveProperty('forwardUserToken');
    const contentHash = await asPreUpgrade(open.id);
    const decided = await approver.decide({ ...open, contentHash });
    expect(decided.status).toBe('APPROVED');
    expect(await approver.finish(open.id)).toBe('ACTIVATED');
    expect((await row(id)).status).toBe('ACTIVE');
  });

  it('an approved ACTIVATE awaiting its deferred activation, hashed without the field, is not blocked', async () => {
    const id = await readyDraft('pre-upgrade-deferred');
    const approved = await approver.approve(admin, 'mcp_connection', id, 'ACTIVATE');
    await asPreUpgrade(approved.id);
    expect(await approver.finish(approved.id)).toBe('ACTIVATED');
    expect((await row(id)).approvedAt).toBeInstanceOf(Date);
  });

  it('an open UPDATE hashed without the field can still be approved; turning forwarding on shows in the projection', async () => {
    const id = await readyDraft('pre-upgrade-update');
    await approver.finish((await approver.approve(admin, 'mcp_connection', id, 'ACTIVATE')).id);
    const open = await approver.submit(admin, 'mcp_connection', id, 'UPDATE', { policy: { allowedAgentIds: '*', confirmationPolicy: 'NONE' } });
    const contentHash = await asPreUpgrade(open.id);
    expect((await approver.decide({ ...open, contentHash })).status).toBe('APPROVED');
    const on = await approver.submit(admin, 'mcp_connection', id, 'UPDATE', { policy: { allowedAgentIds: '*', forwardUserToken: true } });
    expect(on.after).toMatchObject({ forwardUserToken: true });
    expect(on.before).not.toHaveProperty('forwardUserToken');
    // The policy audit row is a settings audit: the forwardUserToken flag is kept, not redacted.
    await approver.decide(on);
    const policyRows = await t.db.select().from(auditEvents).where(eq(auditEvents.targetId, id));
    const turnedOn = policyRows.find((r) => r.action === 'mcp.connection.policy' && (r.after as { forwardUserToken?: unknown }).forwardUserToken === true);
    expect(turnedOn?.before).toMatchObject({ forwardUserToken: false });
  });
});

describe('credentials of a governed connection', () => {
  it('OAuth on a live connection is only a re-authorization; a draft authenticates freely until a proposal locks it', async () => {
    const live = await readyDraft('oauth-live');
    await approver.finish((await approver.approve(admin, 'mcp_connection', live, 'ACTIVATE')).id);
    // A live connection with a header credential (here: none) cannot switch to OAuth directly.
    await expect(t.db.transaction(async (tx) => assertOAuthAllowed(tx, await row(live), null))).rejects.toMatchObject({ code: 'approval_required' });
    await t.db.update(mcpConnections).set({ authStrategy: 'OAUTH', authConfig: { issuer: 'https://as.bank.example', clientId: 'ocso' }, grantedScopes: ['crm.read'] }).where(eq(mcpConnections.id, live));
    const same = { issuer: 'https://as.bank.example', clientId: 'ocso', scopes: ['crm.read'] };
    await expect(t.db.transaction(async (tx) => assertOAuthAllowed(tx, await row(live), same))).resolves.toBeUndefined();
    for (const grant of [{ ...same, issuer: 'https://evil.example' }, { ...same, clientId: 'other' }, { ...same, scopes: ['crm.read', 'crm.write'] }]) {
      await expect(t.db.transaction(async (tx) => assertOAuthAllowed(tx, await row(live), grant))).rejects.toMatchObject({ code: 'approval_required' });
    }
    const draft = await readyDraft('oauth-draft');
    await expect(t.db.transaction(async (tx) => assertOAuthAllowed(tx, await row(draft), same))).resolves.toBeUndefined();
    await approver.submit(admin, 'mcp_connection', draft, 'ACTIVATE');
    await expect(t.db.transaction(async (tx) => assertOAuthAllowed(tx, await row(draft), same))).rejects.toMatchObject({ code: 'approval_open' });
  });

  it('a header credential in a payload must be staged for that connection; another connection’s ref is refused', async () => {
    const victim = await readyDraft('header-victim');
    const staged = await svc.stageHeaderCredential(admin, victim, { headerName: 'Authorization', token: 'Bearer victim-token-123' });
    await approver.finish((await approver.approve(admin, 'mcp_connection', victim, 'ACTIVATE')).id);
    await approver.approve(admin, 'mcp_connection', victim, 'UPDATE', staged.payload);
    const victimRef = (await row(victim)).tokenRef!;
    const target = await readyDraft('header-borrower');
    await approver.finish((await approver.approve(admin, 'mcp_connection', target, 'ACTIVATE')).id);
    await expect(approver.submit(admin, 'mcp_connection', target, 'UPDATE', { headerCredential: { headerName: 'Authorization', ref: victimRef } })).rejects.toMatchObject({
      details: { problems: [expect.objectContaining({ code: 'secret_ref_not_staged' })] },
    });
    expect(await secrets.resolve(victimRef)).toBe('Bearer victim-token-123');
  });
});
