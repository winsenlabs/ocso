import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@ocso/db/testing';
import { uuidv7 } from '@ocso/db';
import type { Principal } from '@ocso/auth';
import { parseOAuthTokenState, serializeOAuthTokenState, type TokensRefreshedEvent } from '@ocso/mcp';
import { InMemorySecretRows, LocalSecretStore, parseMasterKey } from '@ocso/secrets';
import { McpConnectionService, McpOAuthCallbackError, SecretCredentialPort, type ActorContext, type ConnectionView } from '../src/index.js';
import { startTestAuthServer, type TestAuthServer } from '../../mcp/test/helpers/auth-server.js';
import { startDemo, type DemoServer } from '../../mcp/test/helpers/demo-server.js';
import { platformApprover, type PlatformApprover } from './support/platform-approvals.js';

const PUBLIC_URL = 'http://localhost:3000';
const REDIRECT = `${PUBLIC_URL}/oauth/mcp/callback`;
const user = (role: Principal['role'], name: string): Principal => ({ userId: uuidv7(), role, displayName: name, teamIds: [], via: 'UI' });
const admin = user('TECH', 'Tejas Shetty');
const exec = user('SERVICE', 'Ravi Kumar');
const actor = (p: Principal): ActorContext => ({ principal: p, correlationId: 'test-oauth' });

let t: TestDatabase;
let authServer: TestAuthServer;
let rs: DemoServer;
let secrets: LocalSecretStore;
let svc: McpConnectionService;
let conn: ConnectionView;
let approver: PlatformApprover;

const q = async <T = Record<string, any>>(text: string, params: unknown[] = []) => (await t.pool.query(text, params)).rows as T[];

/** Plays the admin's browser: follow the authorize URL to the auto-approving AS and read the redirect back to OCSO. */
async function consent(authorizationUrl: string): Promise<{ code: string; state: string }> {
  const res = await fetch(authorizationUrl, { redirect: 'manual' });
  expect(res.status).toBe(302);
  const location = new URL(res.headers.get('location') ?? '');
  expect(location.origin + location.pathname).toBe(REDIRECT);
  return { code: location.searchParams.get('code') ?? '', state: location.searchParams.get('state') ?? '' };
}

async function failure(p: Promise<unknown>): Promise<McpOAuthCallbackError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(McpOAuthCallbackError);
  return err as McpOAuthCallbackError;
}

const auditText = async (id: string) => (await q<{ row: string }>(`SELECT row_to_json(a)::text AS row FROM audit_events a WHERE target_id = $1`, [id])).map((r) => r.row).join('\n');

beforeAll(async () => {
  t = await createTestDatabase();
  for (const p of [admin, exec]) {
    await t.pool.query(`INSERT INTO users (id, email, name, role) VALUES ($1, $2, $3, $4)`, [p.userId, `${p.userId}@x.test`, p.displayName, p.role]);
  }
  await t.pool.query(`UPDATE deployment_settings SET egress_allowed_internal_hosts = ARRAY['127.0.0.1']`);
  secrets = new LocalSecretStore(new InMemorySecretRows(), parseMasterKey('k1', randomBytes(32).toString('base64')));
  svc = new McpConnectionService({ db: t.db, secrets, publicUrl: PUBLIC_URL });
  approver = await platformApprover(t.db, { secrets });
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
  await t?.drop();
});

describe('MCP OAuth 2.1 connection flow', () => {
  it('discovery reports OAuth availability; begin stores only a hashed, expiring, single-use pending record', async () => {
    conn = await svc.createDraft(actor(admin), { name: 'bank-oauth', url: rs.url, network: 'INTERNAL' });
    const discovered = await svc.discover(actor(admin), conn.id);
    expect(discovered.outcome).toBe('AUTH_REQUIRED');
    expect(discovered.connection.serverInfo['authRequired']).toMatchObject({ oauthAvailable: true, authorizationServers: [authServer.issuer] });

    await expect(svc.beginOAuth(actor(exec), conn.id, {})).rejects.toMatchObject({ code: 'forbidden' });
    const begun = await svc.beginOAuth(actor(admin), conn.id, {});
    const url = new URL(begun.authorizationUrl);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ redirect_uri: REDIRECT, code_challenge_method: 'S256', resource: rs.url });
    const state = url.searchParams.get('state')!;
    expect(Date.parse(begun.expiresAt) - Date.now()).toBeGreaterThan(9 * 60_000);

    const pending = await q(`SELECT * FROM mcp_oauth_pending WHERE connection_id = $1`, [conn.id]);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ state_hash: createHash('sha256').update(state).digest('hex'), user_id: admin.userId });
    expect(JSON.stringify(pending[0])).not.toContain(state);
    expect(await secrets.describe(pending[0]!.pending_ref)).toMatchObject({ kind: 'OTHER' });
  });

  it('rejects forged or missing state without consuming the real one, completes once, and refuses replays', async () => {
    const begun = await svc.beginOAuth(actor(admin), conn.id, {});
    const cb = await consent(begun.authorizationUrl);
    expect(await failure(svc.completeOAuth({ code: cb.code, state: 'forged-state' }, 'c1'))).toMatchObject({ reason: 'state_mismatch', connectionId: null });
    expect((await failure(svc.completeOAuth({ code: cb.code }, 'c1'))).reason).toBe('state_mismatch');
    const [pending] = await q(`SELECT pending_ref FROM mcp_oauth_pending WHERE state_hash = $1`, [createHash('sha256').update(cb.state).digest('hex')]);
    expect(pending).toBeDefined();

    const done = await svc.completeOAuth({ code: cb.code, state: cb.state }, 'c2');
    expect(done.connectionId).toBe(conn.id);
    expect(done.discovery?.outcome).toBe('DISCOVERED');
    expect(done.discovery?.outcome === 'DISCOVERED' && done.discovery.tools.total).toBe(7);
    expect(await q(`SELECT 1 FROM mcp_oauth_pending WHERE state_hash = $1`, [createHash('sha256').update(cb.state).digest('hex')])).toHaveLength(0);
    expect(await secrets.describe(pending!.pending_ref)).toBeNull();

    conn = await svc.get(actor(admin), conn.id);
    expect(conn).toMatchObject({ status: 'PENDING', stage: 'REVIEW', auth: { strategy: 'OAUTH', issuer: authServer.issuer, registration: 'DYNAMIC', scopes: ['meridian:read', 'meridian:write'] } });
    const stored = parseOAuthTokenState(await secrets.resolve(conn.auth.tokenRef!));
    expect(stored).toMatchObject({ issuer: authServer.issuer, resource: rs.url });
    expect(stored.refreshToken).toMatch(/^rt_/);
    expect(JSON.stringify(conn)).not.toContain(stored.accessToken);
    const audit = await auditText(conn.id);
    expect(audit).not.toContain(stored.accessToken);
    expect(audit).not.toContain(stored.refreshToken!);
    expect(audit).toContain(conn.auth.tokenRef!);

    expect(await failure(svc.completeOAuth({ code: cb.code, state: cb.state }, 'c3'))).toMatchObject({ reason: 'state_mismatch' });
  });

  it('rejects a mismatching RFC 9207 issuer and expired authorizations, auditing the failure', async () => {
    const begun = await svc.beginOAuth(actor(admin), conn.id, {});
    const cb = await consent(begun.authorizationUrl);
    expect(await failure(svc.completeOAuth({ ...cb, iss: 'https://evil.example/' }, 'c4'))).toMatchObject({ reason: 'issuer_mismatch', connectionId: conn.id });
    expect(await auditText(conn.id)).toContain('mcp.connection.oauth_failed');

    const again = await svc.beginOAuth(actor(admin), conn.id, {});
    const cb2 = await consent(again.authorizationUrl);
    const later = new McpConnectionService({ db: t.db, secrets, publicUrl: PUBLIC_URL, now: () => new Date(Date.now() + 11 * 60_000) });
    expect((await failure(later.completeOAuth(cb2, 'c5'))).reason).toBe('pending_expired');

    // Abandoned authorizations are swept (row and secret) by the scheduler tick.
    await svc.beginOAuth(actor(admin), conn.id, {});
    const [abandoned] = await q(`SELECT pending_ref FROM mcp_oauth_pending WHERE connection_id = $1`, [conn.id]);
    await later.runDueHealthChecks();
    expect(await q(`SELECT 1 FROM mcp_oauth_pending WHERE connection_id = $1`, [conn.id])).toHaveLength(0);
    expect(await secrets.describe(abandoned!.pending_ref)).toBeNull();
  });

  it('refreshes expired access tokens during health checks and persists the rotated grant', async () => {
    const [tool] = await svc.listTools(actor(admin), conn.id);
    await svc.classifyTools(actor(admin), conn.id, { tools: [{ toolId: tool!.id, riskClass: 'READ', approved: true }] });
    // Going live is an approval, finished by the worker (the deferred probe re-contacts the server).
    await svc.approve(actor(admin), conn.id, { allowedAgentIds: [] });
    expect(await approver.finish((await approver.approve(actor(admin), 'mcp_connection', conn.id, 'ACTIVATE')).id)).toBe('ACTIVATED');
    expect((await svc.get(actor(admin), conn.id)).status).toBe('ACTIVE');

    const ref = conn.auth.tokenRef!;
    const before = parseOAuthTokenState(await secrets.resolve(ref));
    const version = (await secrets.describe(ref))!.version;
    const grants = authServer.refreshGrants;
    authServer.expireAccessTokens();
    expect(await svc.runHealthCheck(conn.id)).toMatchObject({ health: 'HEALTHY', status: 'ACTIVE' });
    expect(authServer.refreshGrants).toBe(grants + 1);
    expect((await secrets.describe(ref))!.version).toBe(version + 1);
    const after = parseOAuthTokenState(await secrets.resolve(ref));
    expect(after.accessToken).not.toBe(before.accessToken);
    expect(after.refreshToken).not.toBe(before.refreshToken);
    expect(await svc.runHealthCheck(conn.id)).toMatchObject({ health: 'HEALTHY' }); // the persisted rotation is usable
  });

  it('compare-and-swap keeps the first rotated refresh token when workers race', async () => {
    const meta = await secrets.put({ name: 'cas test', kind: 'OAUTH_TOKENS', value: 'v1' });
    const event = (serialized: string): TokensRefreshedEvent => ({
      connectionId: conn.id,
      tokenRef: meta.ref,
      issuer: authServer.issuer,
      state: { accessToken: serialized, tokenType: 'bearer', issuer: authServer.issuer },
      serialized,
    });
    const superseded: string[] = [];
    const ports = Array.from({ length: 6 }, () => new SecretCredentialPort(t.db, secrets, { onSuperseded: (id) => superseded.push(id) }));
    for (const p of ports) expect(await p.resolve(meta.ref)).toBe('v1');

    await ports[0]!.onTokensRefreshed(event('winner'));
    await ports[1]!.onTokensRefreshed(event('stale-loser'));
    expect(await secrets.resolve(meta.ref)).toBe('winner');
    expect(superseded).toEqual([conn.id]);
    expect(await ports[1]!.isStale(meta.ref)).toBe(true);

    // Re-read, then race: exactly one concurrent writer lands.
    for (const p of ports) await p.resolve(meta.ref);
    const version = (await secrets.describe(meta.ref))!.version;
    await Promise.all(ports.map((p, i) => p.onTokensRefreshed(event(`race-${i}`))));
    expect((await secrets.describe(meta.ref))!.version).toBe(version + 1);
    expect(await secrets.resolve(meta.ref)).toMatch(/^race-\d$/);
    expect(superseded).toHaveLength(1 + ports.length - 1);
  });

  it('turns AUTH_REQUIRED when tokens expired and the refresh is rejected; re-authorization restores it', async () => {
    const ref = conn.auth.tokenRef!;
    const dead = { ...parseOAuthTokenState(await secrets.resolve(ref)), accessToken: 'at_dead', refreshToken: 'rt_dead', expiresAt: Date.now() - 1_000 };
    await secrets.rotate(ref, serializeOAuthTokenState(dead));
    const outcome = await svc.runHealthCheck(conn.id);
    expect(outcome).toMatchObject({ health: 'AUTH_REQUIRED', previousStatus: 'ACTIVE', status: 'AUTH_REQUIRED', changed: true });
    const view = await svc.get(actor(admin), conn.id);
    expect(view.serverInfo['authRequired']).toMatchObject({ reason: 'token_rejected' });
    expect(await q(`SELECT 1 FROM outbox_events WHERE type = 'config.changed' AND payload->>'entityId' = $1`, [conn.id])).not.toHaveLength(0);

    const begun = await svc.beginOAuth(actor(admin), conn.id, {});
    const done = await svc.completeOAuth(await consent(begun.authorizationUrl), 'c6');
    expect(done.discovery?.connection).toMatchObject({ status: 'ACTIVE', auth: { registration: 'EXISTING' } });
    expect(await secrets.describe(ref)).toBeNull(); // the dead grant's secret was revoked
    expect(await svc.runHealthCheck(conn.id)).toMatchObject({ health: 'HEALTHY', status: 'ACTIVE' });
  });
});
