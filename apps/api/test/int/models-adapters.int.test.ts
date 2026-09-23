import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ModelGateway, UsageRecorder } from '@ocso/agent-runtime';
import { ProfileInput, ProfileService, ProviderService, SettingsService, type ActorContext } from '@ocso/application';
import { CachedProviderAdapterSource, createProviderRegistry } from '@ocso/bootstrap';
import { users, uuidv7 } from '@ocso/db';
import { approveInDb } from './platform.js';
import { createTestDatabase, type TestDatabase } from '@ocso/db/testing';
import { InMemorySecretRows, LocalSecretStore, parseMasterKey } from '@ocso/secrets';

const SECRET = 'sk-ant-adapter-SECRET-0001';
const ROTATED = 'sk-ant-adapter-ROTATED-0002';

let t: TestDatabase;
let providers: ProviderService;
let profiles: ProfileService;
let source: CachedProviderAdapterSource;
const sentKeys: Array<string | null> = [];

const admin: ActorContext = {
  principal: { userId: uuidv7(), role: 'TECH', displayName: 'Admin', teamIds: [], via: 'UI' },
  correlationId: 'adapters',
};

/** Records the API key each outbound request carries, then fails auth (no network). */
const recordingFetch: typeof fetch = async (input, init) => {
  const headers = input instanceof Request ? input.headers : new Headers(init?.headers);
  sentKeys.push(headers.get('x-api-key'));
  return new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }), {
    status: 401,
    headers: { 'content-type': 'application/json' },
  });
};

const media = { resolve: () => Promise.reject(new Error('no media in this test')) };

let registry: ReturnType<typeof createProviderRegistry>;
let secrets: LocalSecretStore;

beforeAll(async () => {
  t = await createTestDatabase();
  registry = createProviderRegistry({ OCSO_ENABLE_DEV_PROVIDERS: true });
  secrets = new LocalSecretStore(new InMemorySecretRows(), parseMasterKey('k1', randomBytes(32).toString('base64')));
  providers = new ProviderService({ db: t.db, secrets, registry });
  profiles = new ProfileService({ db: t.db, registry });
  source = new CachedProviderAdapterSource({ db: t.db, secrets, registry, media, fetch: recordingFetch });
});
afterAll(async () => {
  await t?.drop();
});

const devInput = { kind: 'DEV_SCRIPTED', name: 'Scripted', region: 'ap-south-1', residencyZone: 'IN', settings: { latencyMs: 0, chunkDelayMs: 0 }, credentials: {}, enabled: true, maxConcurrency: 5 } as const;

describe('createProviderRegistry', () => {
  it('registers DEV_SCRIPTED only when enabled', () => {
    expect(createProviderRegistry({ OCSO_ENABLE_DEV_PROVIDERS: false }).get('DEV_SCRIPTED')).toBeUndefined();
    expect(createProviderRegistry({ OCSO_ENABLE_DEV_PROVIDERS: true }).get('DEV_SCRIPTED')?.devOnly).toBe(true);
  });
});

describe('CachedProviderAdapterSource', () => {
  it('reuses one adapter per provider until the row changes', async () => {
    const created = await providers.create(admin, devInput);
    const first = await source.get(created.id);
    expect(await source.get(created.id)).toBe(first);
    await providers.update(admin, created.id, { settings: { latencyMs: 1, chunkDelayMs: 0 } });
    const rebuilt = await source.get(created.id);
    expect(rebuilt).not.toBe(first);
    expect(await source.get(created.id)).toBe(rebuilt);
    source.invalidate(created.id);
    expect(await source.get(created.id)).not.toBe(rebuilt);
  });

  it('resolves credentials from the SecretStore and picks up rotations', async () => {
    const created = await providers.create(admin, {
      kind: 'ANTHROPIC',
      name: 'Anthropic',
      region: 'global',
      residencyZone: 'GLOBAL',
      settings: {},
      credentials: { apiKey: SECRET },
      enabled: true,
      maxConcurrency: 5,
    });
    const health = await (await source.get(created.id)).health('claude-haiku-4-5');
    expect(health.status).toBe('DOWN');
    expect(health.detail ?? '').not.toContain(SECRET);
    expect(sentKeys.at(-1)).toBe(SECRET);
    await providers.update(admin, created.id, { credentials: { apiKey: ROTATED } });
    await (await source.get(created.id)).health('claude-haiku-4-5');
    expect(sentKeys.at(-1)).toBe(ROTATED);
  });

  it('fails clearly for unknown providers and profiles', async () => {
    await expect(source.get(uuidv7())).rejects.toMatchObject({ category: 'not_found' });
    await expect(source.capabilitiesForProfile(uuidv7())).rejects.toMatchObject({ category: 'not_found' });
  });

  it('reports media capabilities of a profile primary and serves the model gateway end to end', async () => {
    const provider = (await providers.list(admin)).find((p) => p.kind === 'DEV_SCRIPTED')!;
    // A new provider is a disabled draft the gateway refuses: enabling it is a second person's approval.
    await t.db.insert(users).values({ id: admin.principal!.userId, email: 'adapters-admin@ocso.test', name: 'Admin', role: 'TECH' }).onConflictDoNothing();
    await approveInDb(t.db, admin, { objectKind: 'model_provider', objectId: provider.id, action: 'ACTIVATE' }, { secrets, providers: registry });
    const profile = await profiles.create(admin, ProfileInput.parse({ name: 'support-primary', providerId: provider.id, model: 'scripted-1' }));
    expect(await source.capabilitiesForProfile(profile.id)).toEqual({ imageInput: true, fileInput: true, audioInput: true });

    const gateway = new ModelGateway(t.db, source, new UsageRecorder(t.db), new SettingsService(t.db));
    const result = await gateway.run({
      profileId: profile.id,
      purpose: 'TURN',
      system: [],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello there' }] }],
      tools: [],
      context: { correlationId: 'gateway-e2e' },
    });
    expect(result.text).toBeTruthy();
    expect(result.fellBack).toBe(false);
    const stats = (await providers.get(admin, provider.id)).stats24h;
    expect(stats).toMatchObject({ requests: 1, errors: 0 });
    expect(stats.inputTokens).toBeGreaterThan(0);
  });
});
