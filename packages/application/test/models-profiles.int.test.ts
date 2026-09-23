import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Principal } from '@ocso/auth';
import { modelProfiles, usageEvents, uuidv7, virtualAgents } from '@ocso/db';
import { createTestDatabase, type TestDatabase } from '@ocso/db/testing';
import { createDefaultRegistry } from '@ocso/model-providers';
import { InMemorySecretRows, LocalSecretStore, parseMasterKey } from '@ocso/secrets';
import {
  PricingInput,
  PricingService,
  ProfileInput,
  ProfileService,
  ProviderService,
  SettingsService,
  readGenerations,
  type ActorContext,
  type ProviderInput,
} from '../src/index.js';

let t: TestDatabase;
let providers: ProviderService;
let profiles: ProfileService;
let pricing: PricingService;
let settings: SettingsService;
const ids: Record<'india' | 'india2' | 'us' | 'offList' | 'global', string> = { india: '', india2: '', us: '', offList: '', global: '' };

const as = (role: Principal['role']): ActorContext => ({
  principal: { userId: uuidv7(), role, displayName: role, teamIds: [], via: 'UI' },
  correlationId: `test-${role}`,
});
const admin = as('PLATFORM_TECH_ADMIN');
const lead = as('CS_LEAD');
const exec = as('CS_EXEC');

const dev = (name: string, region: string, residencyZone: string): ProviderInput => ({
  kind: 'DEV_SCRIPTED',
  name,
  region,
  residencyZone,
  settings: { latencyMs: 0, chunkDelayMs: 0 },
  credentials: {},
  enabled: true,
  maxConcurrency: 5,
});
const profile = (over: Partial<ProfileInput> & { name: string; providerId: string }) => ProfileInput.parse({ model: 'scripted-1', ...over });

beforeAll(async () => {
  t = await createTestDatabase();
  const registry = createDefaultRegistry({ enableDevProviders: true });
  const secrets = new LocalSecretStore(new InMemorySecretRows(), parseMasterKey('k1', randomBytes(32).toString('base64')));
  providers = new ProviderService({ db: t.db, secrets, registry });
  profiles = new ProfileService({ db: t.db, registry });
  pricing = new PricingService({ db: t.db, registry });
  settings = new SettingsService(t.db);
  ids.india = (await providers.create(admin, dev('Mumbai', 'ap-south-1', 'IN'))).id;
  ids.india2 = (await providers.create(admin, dev('Hyderabad', 'ap-south-2', 'IN'))).id;
  ids.us = (await providers.create(admin, dev('Virginia', 'us-east-1', 'US'))).id;
  ids.offList = (await providers.create(admin, dev('Chennai', 'ap-south-1', 'IN'))).id;
  ids.global = (await providers.create(admin, dev('Global', 'global', 'GLOBAL'))).id;
  await settings.updateDeployment(admin, {
    residencyZone: 'IN',
    providerAllowlist: [ids.india, ids.india2, ids.us, ids.global],
    allowCrossProviderFallback: true,
    allowCrossRegionFallback: false,
  });
});
afterAll(async () => {
  await t?.drop();
});

describe('profile policy checks (docs/06 §5)', () => {
  it('saves a compliant profile and warns about fallbacks that will be skipped', async () => {
    const saved = await profiles.create(
      admin,
      profile({ name: 'support-primary', providerId: ids.india, fallbacks: [{ providerId: ids.india2, model: 'scripted-1' }, { providerId: ids.global, model: 'scripted-1' }] }),
    );
    expect(saved).toMatchObject({ name: 'support-primary', providerName: 'Mumbai', region: 'ap-south-1', configVersion: 1, agents: [] });
    expect(saved.policy.ok).toBe(true);
    expect(saved.policy.primary).toMatchObject({ permitted: true, reason: null, capabilities: expect.objectContaining({ imageInput: true }) });
    expect(saved.policy.fallbacks.map((f) => f.reason)).toEqual(['cross_region_forbidden', 'residency_violation']);
    expect(saved.policy.warnings).toHaveLength(2);
    expect(saved.policy.message).toBe('Residency check passed. Permitted targets keep customer data in IN. 2 fallback targets will be skipped.');
  });

  it('rejects a primary target outside the residency zone', async () => {
    await expect(profiles.create(admin, profile({ name: 'us-primary', providerId: ids.us }))).rejects.toMatchObject({
      category: 'policy_denied',
      code: 'model_target_not_permitted',
      details: { providerId: ids.us, reason: 'residency_violation' },
    });
  });

  it('rejects a primary provider that is not allowlisted', async () => {
    await expect(profiles.create(admin, profile({ name: 'chennai', providerId: ids.offList }))).rejects.toMatchObject({
      code: 'model_target_not_permitted',
      details: { reason: 'provider_not_allowlisted' },
    });
  });

  it('rejects a primary that lacks a required capability', async () => {
    await expect(
      profiles.create(admin, profile({ name: 'structured', providerId: ids.india, requiredCapabilities: { structuredOutput: true } })),
    ).rejects.toMatchObject({ details: { reason: 'missing_capability:structuredOutput' } });
  });

  it('validates references, duplicates and names', async () => {
    await expect(profiles.create(admin, profile({ name: 'ghost', providerId: uuidv7() }))).rejects.toMatchObject({ code: 'provider_not_found' });
    await expect(
      profiles.create(admin, profile({ name: 'ghost-fallback', providerId: ids.india, fallbacks: [{ providerId: uuidv7(), model: 'x' }] })),
    ).rejects.toMatchObject({ code: 'fallback_provider_not_found' });
    await expect(
      profiles.create(admin, profile({ name: 'dupe', providerId: ids.india, fallbacks: [{ providerId: ids.india, model: 'scripted-1' }] })),
    ).rejects.toMatchObject({ code: 'duplicate_fallback_target' });
    await expect(profiles.create(admin, profile({ name: 'support-primary', providerId: ids.india }))).rejects.toMatchObject({ code: 'model_profile_name_taken' });
  });

  it('dry-runs the policy check without saving', async () => {
    const before = await t.db.select().from(modelProfiles);
    const check = await profiles.validate(admin, profile({ name: 'draft', providerId: ids.us }));
    expect(check).toMatchObject({ ok: false, primary: { reason: 'residency_violation' }, policy: { residencyZone: 'IN' } });
    expect(check.message).toMatch(/^Primary target not permitted: Virginia keeps data in US, but this deployment requires IN/);
    expect(await t.db.select().from(modelProfiles)).toHaveLength(before.length);
    await expect(profiles.validate(lead, profile({ name: 'draft', providerId: ids.india }))).rejects.toMatchObject({ category: 'authorization' });
  });

  it('applies the cost ceiling using the price table', async () => {
    await pricing.create(admin, pricingInput('scripted-*', 5_000_000));
    await settings.updateDeployment(admin, { maxOutputCostPerMTokMicros: 1_000_000 });
    const check = await profiles.validate(admin, profile({ name: 'pricey', providerId: ids.india }));
    expect(check.primary.reason).toBe('cost_ceiling_exceeded');
    await settings.updateDeployment(admin, { maxOutputCostPerMTokMicros: null });
  });
});

function pricingInput(modelPattern: string, outputPerMTokMicros: number) {
  return { providerKind: 'DEV_SCRIPTED' as const, modelPattern, currency: 'USD', inputPerMTokMicros: 1_000_000, cachedInputPerMTokMicros: null, cacheWritePerMTokMicros: null, outputPerMTokMicros };
}

describe('configuration versions and cache generations', () => {
  it('bumps configVersion and the profile generation on change, not on a no-op', async () => {
    const [row] = await t.db.select().from(modelProfiles).where(eq(modelProfiles.name, 'support-primary'));
    const scope = `profile:${row!.id}` as const;
    const g0 = (await readGenerations(t.db, [scope]))[scope]!;
    const updated = await profiles.update(admin, row!.id, { temperature: 0.2 });
    expect(updated.configVersion).toBe(2);
    expect((await readGenerations(t.db, [scope]))[scope]).toBe(g0 + 1);
    const same = await profiles.update(admin, row!.id, { temperature: 0.2 });
    expect(same.configVersion).toBe(2);
    expect((await readGenerations(t.db, [scope]))[scope]).toBe(g0 + 1);
    await expect(profiles.update(admin, row!.id, { providerId: ids.us })).rejects.toMatchObject({ code: 'model_target_not_permitted' });
  });

  it('bumps the generation of every profile that uses a changed provider (primary or fallback)', async () => {
    const [row] = await t.db.select().from(modelProfiles).where(eq(modelProfiles.name, 'support-primary'));
    const scope = `profile:${row!.id}` as const;
    const before = (await readGenerations(t.db, [scope]))[scope]!;
    await providers.update(admin, ids.india2, { settings: { latencyMs: 1, chunkDelayMs: 0 } });
    await providers.update(admin, ids.india, { maxConcurrency: 7 });
    expect((await readGenerations(t.db, [scope]))[scope]).toBe(before + 2);
  });
});

describe('delete guards', () => {
  it('refuses to delete providers used by profiles, including as fallback', async () => {
    await expect(providers.delete(admin, ids.india)).rejects.toMatchObject({ code: 'model_provider_in_use', details: { profiles: ['support-primary'] } });
    await expect(providers.delete(admin, ids.india2)).rejects.toMatchObject({ code: 'model_provider_in_use' });
  });

  it('refuses to delete a profile referenced by an agent, then deletes it once unassigned', async () => {
    const created = await profiles.create(admin, profile({ name: 'summarizer', providerId: ids.india }));
    const agentId = uuidv7();
    await t.db.insert(virtualAgents).values({ id: agentId, name: 'Maya', slug: 'maya', conversationType: 'SUPPORT', summarizerProfileId: created.id });
    const [listed] = (await profiles.list(lead)).filter((p) => p.id === created.id);
    expect(listed!.agents).toEqual([{ id: agentId, name: 'Maya', usage: 'SUMMARIZER' }]);
    await expect(profiles.delete(admin, created.id)).rejects.toMatchObject({ code: 'model_profile_in_use', details: { agents: ['Maya'] } });
    await t.db.update(virtualAgents).set({ summarizerProfileId: null }).where(eq(virtualAgents.id, agentId));
    await profiles.delete(admin, created.id);
    await expect(profiles.get(admin, created.id)).rejects.toMatchObject({ category: 'not_found' });
  });
});

describe('24h usage stats', () => {
  it('aggregates requests, errors, p95s, tokens, cache reads and cost per provider and profile', async () => {
    const [row] = await t.db.select().from(modelProfiles).where(eq(modelProfiles.name, 'support-primary'));
    const base = { purpose: 'TURN', profileId: row!.id, providerId: ids.india, providerKind: 'DEV_SCRIPTED' as const, model: 'scripted-1', currency: 'USD' };
    const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);
    await t.db.insert(usageEvents).values([
      { ...base, id: uuidv7(), status: 'OK', latencyMs: 100, ttftMs: 50, inputTokens: 1000, cachedInputTokens: 500, outputTokens: 10, costMicros: 100, occurredAt: hoursAgo(1) },
      { ...base, id: uuidv7(), status: 'OK', latencyMs: 200, ttftMs: 60, inputTokens: 1000, cachedInputTokens: 500, outputTokens: 10, costMicros: 100, occurredAt: hoursAgo(2) },
      { ...base, id: uuidv7(), status: 'OK', latencyMs: 1000, ttftMs: 70, inputTokens: 1000, cachedInputTokens: null, outputTokens: 10, costMicros: 100, occurredAt: hoursAgo(3) },
      { ...base, id: uuidv7(), status: 'ERROR', errorCategory: 'timeout', currency: null, occurredAt: hoursAgo(4) },
      { ...base, id: uuidv7(), status: 'OK', latencyMs: 9999, inputTokens: 9999, outputTokens: 9999, occurredAt: hoursAgo(25) },
    ]);
    const provider = (await providers.list(admin)).find((p) => p.id === ids.india)!;
    expect(provider.stats24h).toMatchObject({ requests: 4, errors: 1, errorRate: 0.25, inputTokens: 3000, outputTokens: 30, costMicros: 300, currency: 'USD' });
    expect(provider.stats24h.p95LatencyMs).toBe(920);
    expect(provider.stats24h.p95TtftMs).toBe(69);
    expect(provider.stats24h.cacheReadRatio).toBeCloseTo(0.5);
    expect(provider.profiles).toEqual([{ id: row!.id, name: 'support-primary', role: 'PRIMARY' }]);
    expect(provider.policy).toEqual({ allowlisted: true, residency: 'COMPLIANT' });
    expect((await providers.list(admin)).find((p) => p.id === ids.offList)!.policy).toEqual({ allowlisted: false, residency: 'COMPLIANT' });

    const listed = (await profiles.list(admin)).find((p) => p.id === row!.id)!;
    expect(listed.stats24h).toMatchObject({ requests: 4, p95LatencyMs: 920, inputTokens: 3000 });
    expect(listed.fallbacks.map((f) => f.providerName)).toEqual(['Hyderabad', 'Global']);
  });

  it('lets agent readers list profiles without technical telemetry', async () => {
    const asExec = await profiles.list(exec);
    expect(asExec.length).toBeGreaterThan(0);
    expect(asExec.every((p) => p.stats24h === null)).toBe(true);
    await expect(profiles.list({ principal: null, correlationId: 'x' })).rejects.toMatchObject({ category: 'authorization' });
  });
});

describe('pricing', () => {
  it('supports CRUD for pricing managers only', async () => {
    const row = await pricing.create(admin, pricingInput('claude-sonnet-4-*', 15_000_000));
    const updated = await pricing.update(admin, row.id, { outputPerMTokMicros: 14_000_000 });
    expect(updated.outputPerMTokMicros).toBe(14_000_000);
    expect((await pricing.list(admin)).map((p) => p.modelPattern)).toContain('claude-sonnet-4-*');
    await expect(pricing.list(lead)).rejects.toMatchObject({ category: 'authorization' });
    await pricing.delete(admin, row.id);
    await expect(pricing.update(admin, row.id, { outputPerMTokMicros: 1 })).rejects.toMatchObject({ category: 'not_found' });
  });

  it('accepts any well-formed kind at the input, but only kinds registered in this deployment', async () => {
    expect(PricingInput.safeParse({ ...pricingInput('m-*', 1), providerKind: 'MISTRAL' }).success).toBe(true);
    expect(PricingInput.safeParse({ ...pricingInput('m-*', 1), providerKind: 'mistral' }).success).toBe(false);
    await expect(pricing.create(admin, { ...pricingInput('m-*', 1), providerKind: 'MISTRAL' })).rejects.toMatchObject({ code: 'provider_kind_not_available' });
    await expect(pricing.addFromCatalog(admin, { providerKind: 'MISTRAL', model: 'mistral-large' })).rejects.toMatchObject({ code: 'provider_kind_not_available' });
    await expect(providers.create(admin, { ...dev('Mistral', 'eu-west-1', 'EU'), kind: 'MISTRAL' })).rejects.toMatchObject({ code: 'provider_kind_not_available' });
  });
});
