import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Principal } from '@ocso/auth';
import { auditEvents, modelProviders, outboxEvents, uuidv7 } from '@ocso/db';
import { createTestDatabase, type TestDatabase } from '@ocso/db/testing';
import { createDefaultRegistry } from '@ocso/model-providers';
import { InMemorySecretRows, LocalSecretStore, parseMasterKey } from '@ocso/secrets';
import { ProviderService, sweepApprovalSecrets, type ActorContext } from '../src/index.js';
import { platformApprover, type PlatformApprover } from './support/platform-approvals.js';

const SECRET = 'sk-ant-test-VERY-SECRET-0123456789';
const ROTATED = 'sk-ant-test-ROTATED-SECRET-987654';

let t: TestDatabase;
let rows: InMemorySecretRows;
let secrets: LocalSecretStore;
let providers: ProviderService;
let approver: PlatformApprover;

const as = (role: Principal['role']): ActorContext => ({
  principal: { userId: uuidv7(), role, displayName: role, teamIds: [], via: 'UI' },
  correlationId: `test-${role}`,
});
const admin = as('TECH');
const lead = as('HEAD');
const exec = as('SERVICE');
const dev = (name: string, settings: Record<string, unknown> = {}) =>
  ({ kind: 'DEV_SCRIPTED', name, region: 'ap-south-1', residencyZone: 'IN', settings: { latencyMs: 0, chunkDelayMs: 0, ...settings }, credentials: {}, enabled: true, maxConcurrency: 5 }) as const;

beforeAll(async () => {
  t = await createTestDatabase();
  rows = new InMemorySecretRows();
  secrets = new LocalSecretStore(rows, parseMasterKey('k1', randomBytes(32).toString('base64')));
  const registry = createDefaultRegistry({ enableDevProviders: true });
  providers = new ProviderService({ db: t.db, secrets, registry });
  approver = await platformApprover(t.db, { secrets, providers: registry });
});
afterAll(async () => {
  await t?.drop();
});

describe('provider create validation', () => {
  const anthropic = { kind: 'ANTHROPIC', name: 'Anthropic', region: 'global', residencyZone: 'GLOBAL', settings: {}, enabled: true, maxConcurrency: 10 } as const;

  it('validates settings and credentials against the provider definition (field names only)', async () => {
    await expect(providers.create(admin, { ...dev('Bad dev'), settings: { latencyMs: -1 } })).rejects.toMatchObject({
      code: 'provider_settings_invalid',
      details: { issues: [expect.objectContaining({ path: 'latencyMs' })] },
    });
    await expect(providers.create(admin, { ...anthropic, credentials: {} })).rejects.toMatchObject({
      code: 'provider_credentials_invalid',
      details: { fields: ['apiKey'] },
    });
    const unknown = providers.create(admin, { ...anthropic, credentials: { apiKey: SECRET, extra: 'x' } });
    await expect(unknown).rejects.toMatchObject({ code: 'provider_credentials_invalid', details: { fields: ['extra'] } });
    await expect(unknown.catch((e: Error) => JSON.stringify({ m: e.message, d: (e as { details?: unknown }).details }))).resolves.not.toContain(SECRET);
    // Cross-field rule enforced by the adapter factory: Bedrock needs a region.
    await expect(
      providers.create(admin, { ...anthropic, kind: 'BEDROCK', region: null, credentials: { accessKeyId: 'AKIA', secretAccessKey: 's' } }),
    ).rejects.toMatchObject({ code: 'provider_settings_invalid' });
    // Nothing was stored for rejected configurations.
    await expect(rows.list()).resolves.toHaveLength(0);
  });

  it('rejects kinds this deployment does not register', async () => {
    const prod = new ProviderService({ db: t.db, secrets, registry: createDefaultRegistry({ enableDevProviders: false }) });
    await expect(prod.create(admin, dev('Dev'))).rejects.toMatchObject({ code: 'provider_kind_not_available' });
  });

  it('enforces RBAC in the service', async () => {
    await expect(providers.create(lead, dev('Lead dev'))).rejects.toMatchObject({ category: 'authorization' });
    await expect(providers.list(exec)).rejects.toMatchObject({ category: 'authorization' });
    await expect(providers.list(lead)).resolves.toBeInstanceOf(Array);
  });
});

describe('credentials live only in the SecretStore', () => {
  let id: string;
  let ref: string;

  it('stores ciphertext and returns only references', async () => {
    const view = await providers.create(admin, {
      kind: 'ANTHROPIC',
      name: 'Anthropic prod',
      region: 'global',
      residencyZone: 'GLOBAL',
      settings: {},
      credentials: { apiKey: SECRET },
      enabled: true,
      maxConcurrency: 10,
    });
    id = view.id;
    ref = view.secretRefs['apiKey']!;
    expect(ref).toMatch(/^sec_/);
    expect(view).toMatchObject({ kind: 'ANTHROPIC', kindLabel: 'Anthropic API', status: 'UNTESTED', available: true, devOnly: false });
    expect(JSON.stringify(view)).not.toContain(SECRET);

    const [row] = await t.db.select().from(modelProviders).where(eq(modelProviders.id, id));
    expect(row!.secretRefs).toEqual({ apiKey: ref });
    expect(JSON.stringify(row)).not.toContain(SECRET);
    const stored = rows.raw(ref)!;
    expect(stored.ciphertext?.data).toBeTruthy();
    expect(JSON.stringify(stored)).not.toContain(SECRET);
    expect(stored).toMatchObject({ kind: 'API_KEY', usedBy: 'provider:Anthropic prod' });
    expect(await secrets.resolve(ref)).toBe(SECRET);

    const audits = await t.db.select().from(auditEvents).where(eq(auditEvents.targetId, id));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.after).toMatchObject({ credentialKeys: ['apiKey'] });
    expect(JSON.stringify(audits)).not.toContain(SECRET);
    const events = await t.db.select().from(outboxEvents).where(eq(outboxEvents.type, 'config.changed'));
    expect(events.map((e) => e.payload)).toContainEqual({ area: 'model_provider', entityId: id });
  });

  it('replaces an existing credential with a new secret (never rotated in place) and never echoes it', async () => {
    const before = (await t.db.select().from(modelProviders).where(eq(modelProviders.id, id)))[0]!;
    const view = await providers.update(admin, id, { credentials: { apiKey: ROTATED } });
    const old = ref;
    ref = view.secretRefs['apiKey']!;
    expect(ref).not.toBe(old);
    expect(JSON.stringify(view)).not.toMatch(new RegExp(`${SECRET}|${ROTATED}`));
    expect(await secrets.resolve(ref)).toBe(ROTATED);
    // The replaced value is deleted once the write commits.
    expect(rows.raw(old)).toBeUndefined();
    expect(new Date(view.updatedAt).getTime()).toBeGreaterThanOrEqual(before.updatedAt.getTime());
    const audits = await t.db.select().from(auditEvents).where(eq(auditEvents.targetId, id));
    expect(audits.map((a) => a.summary)).toContain('Updated provider Anthropic prod (credentials changed: apiKey)');
    expect(JSON.stringify(audits)).not.toMatch(new RegExp(`${SECRET}|${ROTATED}`));
  });

  it('refuses to drop a required credential and leaves the secret untouched', async () => {
    await expect(providers.update(admin, id, { credentials: { apiKey: null } })).rejects.toMatchObject({ code: 'provider_credentials_invalid' });
    expect(await secrets.resolve(ref)).toBe(ROTATED);
  });

  it('keeps provider names unique (case-insensitive)', async () => {
    await expect(providers.create(admin, { ...dev('ANTHROPIC PROD') })).rejects.toMatchObject({ code: 'model_provider_name_taken' });
  });

  it('deletes an unused provider together with its secrets — always through an approval', async () => {
    await expect(providers.delete(admin, id)).rejects.toMatchObject({ code: 'approval_required', details: { action: 'DELETE' } });
    expect(rows.raw(ref)).toBeDefined();
    expect((await approver.approve(admin, 'model_provider', id, 'DELETE')).status).toBe('APPROVED');
    // Released in the approval's transaction; the leader sweep deletes it after that commits.
    expect(rows.raw(ref)).toBeDefined();
    expect((await sweepApprovalSecrets(t.db, secrets)).released).toBe(1);
    expect(rows.raw(ref)).toBeUndefined();
    await expect(providers.get(admin, id)).rejects.toMatchObject({ category: 'not_found' });
  });
});

describe('test connection (DEV_SCRIPTED)', () => {
  it('runs health plus a tiny generation and records health on the row', async () => {
    const created = await providers.create(admin, dev('Scripted IN'));
    const result = await providers.test(admin, created.id, { model: 'scripted-1' });
    expect(result).toMatchObject({ status: 'OK', model: 'scripted-1', health: { status: 'OK' } });
    expect(result.call).toMatchObject({ ok: true, model: 'scripted-1', error: null });
    expect(result.call!.replyPreview).toBeTruthy();
    expect(result.call!.usage!.outputTokens).toBeGreaterThan(0);
    expect(result.capabilities).toMatchObject({ imageInput: true, toolCalling: true, streaming: true });
    const view = await providers.get(admin, created.id);
    expect(view).toMatchObject({ status: 'OK', lastError: null });
    expect(view.lastHealthAt).toBeTruthy();
    expect(typeof view.lastHealthLatencyMs).toBe('number');
    // Health fields do not count as configuration changes (adapter cache key).
    expect(view.updatedAt).toBe(created.updatedAt);
  });

  it('falls back to the adapter default model when none is configured', async () => {
    const created = await providers.create(admin, dev('Scripted default'));
    const result = await providers.test(admin, created.id);
    expect(result).toMatchObject({ status: 'OK', model: null, call: null, capabilities: null });
  });

  it('reports DOWN with a value-free error when the provider fails', async () => {
    const created = await providers.create(admin, dev('Scripted broken', { simulateError: 'UNAVAILABLE' }));
    const result = await providers.test(admin, created.id, { model: 'scripted-1' });
    expect(result.status).toBe('DOWN');
    expect(result.call).toBeNull();
    const view = await providers.get(admin, created.id);
    expect(view.status).toBe('DOWN');
    expect(view.lastError).toMatch(/^provider_/);
  });

  it('requires providers.manage to run a test', async () => {
    const [any] = await providers.list(admin);
    await expect(providers.test(lead, any!.id)).rejects.toMatchObject({ category: 'authorization' });
  });

  it('starts disabled; enabling is approved, disabling is immediate, re-enabling is approved again', async () => {
    const created = await providers.create(admin, dev('Scripted toggle'));
    expect(created.enabled).toBe(false);
    await expect(providers.setEnabled(admin, created.id, true)).rejects.toMatchObject({ code: 'approval_required', details: { action: 'ACTIVATE' } });
    await approver.approve(admin, 'model_provider', created.id, 'ACTIVATE');
    expect((await providers.get(admin, created.id)).enabled).toBe(true);
    // Approved: a change is a proposal now, and the object is locked while it is open — but disabling is not.
    await expect(providers.update(admin, created.id, { maxConcurrency: 7 })).rejects.toMatchObject({ code: 'approval_required' });
    const open = await approver.submit(admin, 'model_provider', created.id, 'UPDATE', { maxConcurrency: 7 });
    expect((await providers.setEnabled(admin, created.id, false)).enabled).toBe(false);
    // The stop did not void the open proposal (`enabled` is outside its content hash).
    expect((await approver.decide(open)).status).toBe('APPROVED');
    expect((await providers.get(admin, created.id)).maxConcurrency).toBe(7);
    await expect(providers.setEnabled(admin, created.id, true)).rejects.toMatchObject({ code: 'approval_required' });
    await approver.approve(admin, 'model_provider', created.id, 'ACTIVATE');
    expect((await providers.get(admin, created.id)).enabled).toBe(true);
  });
});
