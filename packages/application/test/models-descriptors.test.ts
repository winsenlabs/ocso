import { describe, expect, it } from 'vitest';
import type { Principal } from '@ocso/auth';
import type { Db } from '@ocso/db';
import { createDefaultRegistry } from '@ocso/model-providers';
import type { SecretStore } from '@ocso/secrets';
import { z } from 'zod';
import { PROFILE_NAME, ProfileInput, ProviderService, describeSchemaFields, humanizeFieldName, secretKindFor, type ActorContext } from '../src/index.js';

const actor = (role: Principal['role']): ActorContext => ({
  principal: { userId: '00000000-0000-7000-8000-000000000001', role, displayName: role, teamIds: [], via: 'UI' },
  correlationId: 'unit',
});

describe('zod → field descriptors', () => {
  it('humanizes camelCase and acronym field names', () => {
    expect(humanizeFieldName('accessKeyId')).toBe('Access key id');
    expect(humanizeFieldName('baseURL')).toBe('Base URL');
    expect(humanizeFieldName('serviceAccountJson')).toBe('Service account json');
  });

  it('describes types, requiredness, enums, defaults, bounds and descriptions', () => {
    const schema = z.object({
      region: z.string().regex(/^[a-z]+$/).describe('AWS region'),
      authMode: z.enum(['A', 'B']).default('A'),
      baseURL: z.url().optional(),
      latencyMs: z.number().int().min(0).max(100).default(5),
      store: z.boolean().default(false),
      deployments: z.record(z.string(), z.object({ x: z.string() })).default({}),
      ttl: z.enum(['5m', '1h']).nullable(),
    });
    const fields = Object.fromEntries(describeSchemaFields(schema, { secret: false }).map((f) => [f.name, f]));
    expect(fields['region']).toMatchObject({ type: 'string', required: true, description: 'AWS region', pattern: '^[a-z]+$', secret: false });
    expect(fields['authMode']).toMatchObject({ type: 'enum', required: false, options: ['A', 'B'], default: 'A' });
    expect(fields['baseURL']).toMatchObject({ type: 'url', required: false });
    expect(fields['latencyMs']).toMatchObject({ type: 'integer', min: 0, max: 100, default: 5 });
    expect(fields['store']).toMatchObject({ type: 'boolean', default: false });
    expect(fields['deployments']).toMatchObject({ type: 'json', required: false });
    expect(fields['ttl']).toMatchObject({ type: 'enum', options: ['5m', '1h'], required: true });
  });

  it('never exposes defaults for secret fields', () => {
    const [field] = describeSchemaFields(z.object({ apiKey: z.string().default('dont-leak') }), { secret: true });
    expect(field).toMatchObject({ name: 'apiKey', secret: true });
    expect(field).not.toHaveProperty('default');
  });

  it('lists every registered provider kind with its forms (dev kinds only when enabled)', () => {
    const service = (dev: boolean) =>
      new ProviderService({ db: {} as Db, secrets: {} as SecretStore, registry: createDefaultRegistry({ enableDevProviders: dev }) });
    const kinds = service(true).kinds(actor('TECH'));
    const byKind = Object.fromEntries(kinds.map((k) => [k.kind, k]));
    expect(Object.keys(byKind).sort()).toEqual(['ANTHROPIC', 'BEDROCK', 'DEV_SCRIPTED', 'FOUNDRY', 'OPENAI', 'SARVAM', 'VERTEX']);
    expect(byKind['ANTHROPIC']!.credentials).toEqual([expect.objectContaining({ name: 'apiKey', required: true, secret: true, type: 'string' })]);
    const bedrockAuth = byKind['BEDROCK']!.settings.find((f) => f.name === 'authMode');
    expect(bedrockAuth).toMatchObject({ type: 'enum', options: ['ACCESS_KEYS', 'IAM_ROLE', 'API_KEY'], default: 'ACCESS_KEYS', required: false });
    expect(byKind['BEDROCK']!.credentials.every((f) => f.secret && !f.required)).toBe(true);
    // Foundry's schema carries a refinement; its fields are still described.
    expect(byKind['FOUNDRY']!.settings.map((f) => f.name)).toEqual(expect.arrayContaining(['resourceName', 'endpoint', 'deployments']));
    expect(byKind['DEV_SCRIPTED']).toMatchObject({ devOnly: true, credentials: [], mark: 'DEV' });
    // Per-kind UI knowledge comes from the definitions, never from the web app.
    for (const k of kinds) expect(k).toMatchObject({ label: expect.any(String), mark: expect.stringMatching(/^[A-Z0-9]{1,4}$/), cachingSummary: expect.any(String) });
    expect(byKind['BEDROCK']).toMatchObject({ mark: 'AWS', cachingSummary: expect.stringContaining('cachePoint') });
    expect(byKind['DEV_SCRIPTED']!.settings.find((f) => f.name === 'latencyMs')).toMatchObject({ type: 'integer', min: 0, max: 30_000, default: 300 });
    expect(service(false).kinds(actor('HEAD')).map((k) => k.kind)).not.toContain('DEV_SCRIPTED');
  });

  it('requires providers.read to list kinds', () => {
    const svc = new ProviderService({ db: {} as Db, secrets: {} as SecretStore, registry: createDefaultRegistry({ enableDevProviders: false }) });
    expect(() => svc.kinds(actor('SERVICE'))).toThrow(expect.objectContaining({ category: 'authorization' }));
    expect(() => svc.kinds({ principal: null, correlationId: 'x' })).toThrow(expect.objectContaining({ category: 'authorization' }));
  });
});

describe('model admin inputs', () => {
  it('accepts only lowercase slug profile names', () => {
    for (const ok of ['support-primary', 'ab', 'summarizer', 'voice-marathi-2']) expect(PROFILE_NAME.test(ok)).toBe(true);
    for (const bad of ['Support', 'a', '1abc', '-x', 'support_primary', `a${'b'.repeat(49)}`]) expect(PROFILE_NAME.test(bad)).toBe(false);
    const base = { providerId: '00000000-0000-7000-8000-000000000002', model: 'm' };
    expect(ProfileInput.safeParse({ ...base, name: 'Support-Primary' }).success).toBe(false);
    expect(ProfileInput.parse({ ...base, name: 'support-primary' })).toMatchObject({ cachePolicy: 'PREFIX', fallbacks: [], maxOutputTokens: 1024 });
  });

  it('classifies credential names for the secrets inventory', () => {
    expect(secretKindFor('apiKey')).toBe('API_KEY');
    expect(secretKindFor('secretAccessKey')).toBe('IAM_CREDENTIALS');
    expect(secretKindFor('serviceAccountJson')).toBe('SERVICE_ACCOUNT');
    expect(secretKindFor('clientSecret')).toBe('OAUTH_CLIENT');
    expect(secretKindFor('whatever')).toBe('OTHER');
  });
});
