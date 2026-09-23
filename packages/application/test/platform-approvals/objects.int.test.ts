import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Principal } from '@ocso/auth';
import { authSsoProviders, modelPricing, modelProfiles, modelProviders, uuidv7, virtualAgents } from '@ocso/db';
import { createTestDatabase, type TestDatabase } from '@ocso/db/testing';
import { createDefaultRegistry, selectPrice } from '@ocso/model-providers';
import { PLATFORM_APPROVAL_KINDS, PricingService, ProfileService, assertPlatformWrite, isApproved, profilesInUse, seedDefaultAlertRules, type ActorContext, type ProposalRow } from '../../src/index.js';
import { ssoUserResolver } from '../../src/identity/auth/sso-resolver.js';
import type { AuthAudit } from '../../src/identity/auth/audit.js';
import { ensureUser, platformApprover, type PlatformApprover } from '../support/platform-approvals.js';

/**
 * Model pricing, model profiles and SSO providers under maker–checker (PM/research/11 §4), and the invariant
 * the grandfather migration relies on: every platform object that is live has an approval, and drafts are
 * never live.
 */

let t: TestDatabase;
let approver: PlatformApprover;
const registry = createDefaultRegistry({ enableDevProviders: true });
const tech: Principal = { userId: uuidv7(), role: 'TECH', displayName: 'Tarun Tech', teamIds: [], via: 'UI' };
const admin: ActorContext = { principal: tech, correlationId: 'objects-test' };
let providerId: string;

beforeAll(async () => {
  t = await createTestDatabase();
  await ensureUser(t.db, tech);
  approver = await platformApprover(t.db, { providers: registry });
  providerId = uuidv7();
  await t.db.insert(modelProviders).values({ id: providerId, kind: 'DEV_SCRIPTED', name: 'Scripted', enabled: true });
});
afterAll(async () => {
  await t?.drop();
});

describe('manual prices', () => {
  const pricing = () => new PricingService({ db: t.db, registry });
  const input = { providerKind: 'DEV_SCRIPTED', modelPattern: 'scripted-*', currency: 'USD', inputPerMTokMicros: 1_000_000, cachedInputPerMTokMicros: null, cacheWritePerMTokMicros: null, outputPerMTokMicros: 2_000_000 };

  it('a price a person enters is a draft that prices nothing until approved', async () => {
    const row = await pricing().create(admin, input);
    expect(row.status).toBe('DRAFT');
    const rows = () => t.db.select().from(modelPricing);
    expect(selectPrice(await rows(), 'DEV_SCRIPTED', 'scripted-1', new Date())).toBeUndefined();
    await pricing().update(admin, row.id, { outputPerMTokMicros: 3_000_000 });
    await approver.approve(admin, 'model_pricing', row.id, 'ACTIVATE');
    expect(selectPrice(await rows(), 'DEV_SCRIPTED', 'scripted-1', new Date())?.outputPerMTokMicros).toBe(3_000_000);
    await expect(pricing().update(admin, row.id, { outputPerMTokMicros: 1 })).rejects.toMatchObject({ code: 'approval_required' });
  });

  it("a catalog row is live: a person's edit is a proposal (and makes it manual)", async () => {
    const id = uuidv7();
    await t.db.insert(modelPricing).values({ id, providerKind: 'DEV_SCRIPTED', modelPattern: 'scripted-2', inputPerMTokMicros: 1, outputPerMTokMicros: 1, origin: 'catalog' });
    await expect(pricing().update(admin, id, { outputPerMTokMicros: 5 })).rejects.toMatchObject({ code: 'approval_required' });
    await approver.approve(admin, 'model_pricing', id, 'UPDATE', { outputPerMTokMicros: 5 });
    expect((await t.db.select().from(modelPricing).where(eq(modelPricing.id, id)))[0]).toMatchObject({ origin: 'manual', outputPerMTokMicros: 5, status: 'ACTIVE' });
  });
});

describe('model profiles', () => {
  const profiles = () => new ProfileService({ db: t.db, registry });

  it('a draft profile is edited directly until something live uses it; then every change is a proposal', async () => {
    const p = await profiles().create(admin, { name: 'support-draft', description: null, providerId, model: 'scripted-1', temperature: null, maxOutputTokens: 512, reasoning: null, timeoutMs: 30_000, retries: 0, retryBackoffMs: 400, cachePolicy: 'PREFIX', cacheTtl: null, fallbacks: [], requiredCapabilities: {} });
    expect((await profiles().update(admin, p.id, { maxOutputTokens: 600 })).maxOutputTokens).toBe(600);
    await t.db.insert(virtualAgents).values({ id: uuidv7(), name: 'Maya', slug: 'maya', conversationType: 'SUPPORT', status: 'LIVE', modelProfileId: p.id });
    expect((await profilesInUse(t.db, [p.id])).has(p.id)).toBe(true);
    await expect(profiles().update(admin, p.id, { maxOutputTokens: 700 })).rejects.toMatchObject({ code: 'approval_required' });
    await approver.approve(admin, 'model_profile', p.id, 'UPDATE', { maxOutputTokens: 700 });
    expect((await t.db.select().from(modelProfiles).where(eq(modelProfiles.id, p.id)))[0]!.maxOutputTokens).toBe(700);
    await expect(approver.submit(admin, 'model_profile', p.id, 'DELETE')).rejects.toMatchObject({ details: { problems: [expect.objectContaining({ code: 'model_profile_in_use' })] } });
  });

  it('an agent goes live (or changes while live) only on approved model profiles', async () => {
    const p = await profiles().create(admin, { name: 'unreviewed', description: null, providerId, model: 'scripted-1', temperature: null, maxOutputTokens: 512, reasoning: null, timeoutMs: 30_000, retries: 0, retryBackoffMs: 400, cachePolicy: 'PREFIX', cacheTtl: null, fallbacks: [], requiredCapabilities: {} });
    const agentId = uuidv7();
    await t.db.insert(virtualAgents).values({ id: agentId, name: 'Riya', slug: 'riya-unreviewed', conversationType: 'SUPPORT', modelProfileId: p.id });
    const agent = approver.approvals['registry'].get('agent');
    const proposal = { objectKind: 'agent', objectId: agentId, action: 'ACTIVATE', payload: {}, makerId: tech.userId } as unknown as ProposalRow;
    expect((await agent.validate(t.db, proposal)).map((x) => x.code)).toContain('model_profile_not_approved');
    const pending = await approver.submit(admin, 'model_profile', p.id, 'ACTIVATE');
    expect((await agent.validate(t.db, proposal)).find((x) => x.code === 'model_profile_not_approved_pending')).toMatchObject({ soft: true });
    await approver.decide(pending);
    expect((await agent.validate(t.db, proposal)).map((x) => x.code)).not.toContain('model_profile_not_approved');
  });

  it('"approve for use" is an ACTIVATE that changes nothing but records the platform approval', async () => {
    const p = await profiles().create(admin, { name: 'support-fast', description: null, providerId, model: 'scripted-1', temperature: null, maxOutputTokens: 512, reasoning: null, timeoutMs: 30_000, retries: 0, retryBackoffMs: 400, cachePolicy: 'PREFIX', cacheTtl: null, fallbacks: [], requiredCapabilities: {} });
    expect(await isApproved(t.db, 'model_profile', p.id)).toBe(false);
    expect((await approver.approve(admin, 'model_profile', p.id, 'ACTIVATE')).title).toBe('Approve model profile support-fast');
    expect(await isApproved(t.db, 'model_profile', p.id)).toBe(true);
    await expect(approver.submit(admin, 'model_profile', p.id, 'ACTIVATE')).rejects.toMatchObject({ details: { problems: [expect.objectContaining({ code: 'already_approved' })] } });
  });
});

describe('SSO providers', () => {
  const audit = { asSystem: async () => {}, asUser: async () => {} } as unknown as AuthAudit;
  const resolve = ssoUserResolver(t0(), audit);
  function t0() {
    return new Proxy({}, { get: (_o, k) => (t.db as unknown as Record<string | symbol, unknown>)[k] }) as typeof t.db;
  }

  it('a newly registered provider is a draft that refuses sign-in until approved; disabling is immediate', async () => {
    const id = uuidv7();
    await t.db.insert(authSsoProviders).values({ id, issuer: 'https://idp.bank.example', providerId: 'bank-okta', domain: 'bank.example', name: 'Bank Okta', oidcConfig: JSON.stringify({ clientId: 'ocso', clientSecret: 'IDP-CLIENT-SECRET' }) });
    const [row] = await t.db.select().from(authSsoProviders).where(eq(authSsoProviders.id, id));
    expect(row!.status).toBe('DRAFT');
    const input = { providerId: 'bank-okta', providerUser: { email: 'someone@bank.example', name: 'Someone' } } as never;
    expect(await resolve(input)).toMatchObject({ action: 'reject', code: 'sso_provider_inactive' });
    const proposal = await approver.approve(admin, 'sso_provider', id, 'ACTIVATE');
    expect(JSON.stringify(proposal)).not.toContain('IDP-CLIENT-SECRET');
    expect(await resolve(input)).toMatchObject({ action: 'reject', code: 'sso_not_invited' });
    await expect(approver.submit(admin, 'sso_provider', id, 'UPDATE', { autoProvision: true, clientSecret: 'x' })).rejects.toMatchObject({ code: 'invalid_payload' });
    await approver.approve(admin, 'sso_provider', id, 'UPDATE', { autoProvision: true });
    expect((await t.db.select().from(authSsoProviders).where(eq(authSsoProviders.id, id)))[0]!.autoProvision).toBe(true);
    await t.db.update(authSsoProviders).set({ status: 'DISABLED' }).where(eq(authSsoProviders.id, id));
    expect(await resolve(input)).toMatchObject({ action: 'reject', code: 'sso_provider_inactive' });
    await approver.approve(admin, 'sso_provider', id, 'DELETE');
    expect(await t.db.select().from(authSsoProviders).where(eq(authSsoProviders.id, id))).toHaveLength(0);
  });
});

describe('live objects and approvals (what the grandfather migration relies on)', () => {
  it('a live object with no approval on record (upgraded before 0031) is governed, never a draft', async () => {
    expect(await isApproved(t.db, 'model_provider', providerId)).toBe(false);
    expect(await approver.approvals.gate(tech, 'model_provider', providerId, 'UPDATE')).toEqual({ needed: true, openId: null });
    await expect(t.db.transaction((tx) => assertPlatformWrite(tx, 'model_provider', providerId))).rejects.toMatchObject({ code: 'approval_required' });
  });

  it('the default in-app destination setup installs is recorded as installed configuration', async () => {
    const { destinationId } = await seedDefaultAlertRules(t.db);
    expect(await isApproved(t.db, 'notification_destination', destinationId)).toBe(true);
  });

  it('every live platform object created through the services here has an approval; drafts are not live', async () => {
    const d = (kind: string) => approver.approvals['registry'].get(kind);
    for (const kind of PLATFORM_APPROVAL_KINDS) {
      const live = await d(kind).liveObjects(t.db);
      const unapproved = [];
      for (const id of live) if (!(await isApproved(t.db, kind, id))) unapproved.push(id);
      // The fixture's provider (inserted enabled, like a pre-existing one) and the settings singleton were live
      // before any approval here: exactly what 0031 grandfathers. Everything else went live through approvals.
      const expected = kind === 'model_provider' ? [providerId] : kind === 'deployment_settings' ? live : [];
      expect(unapproved.sort(), kind).toEqual([...expected].sort());
    }
  });
});
