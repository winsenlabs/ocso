'use server';

import { refresh } from 'next/cache';
import { Permission } from '@ocso/auth';
import { z } from 'zod';
import { describeApiError } from '../api/errors';
import {
  CAPABILITY_KEYS,
  PROVIDER_KINDS,
  createPricing,
  createProfile,
  createProvider,
  deletePricing,
  deleteProfile,
  deleteProvider,
  testProvider,
  updatePricing,
  updateProfile,
  updateProvider,
  validateProfile,
  type PolicyCheck,
  type ProfileSaveResult,
  type ProviderTestResult,
} from '../api/models';
import { getSession } from '../session';

/** Result of a connections-screen server action (called directly from client components). */
export type ActionResult<T = null> = { ok: true; data: T } | { ok: false; message: string };

async function guard(permission: Permission, what: string): Promise<string | null> {
  const session = await getSession();
  if (!session) return 'Your session has ended. Sign in again.';
  return session.permissions.has(permission) ? null : `Your role cannot ${what}.`;
}

/** Validate input, check the permission, call the API, refresh the page on success. */
async function run<I, T>(permission: Permission, what: string, schema: z.ZodType<I>, raw: unknown, call: (input: I) => Promise<T>, reload = true): Promise<ActionResult<T>> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return { ok: false, message: parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ') };
  const denied = await guard(permission, what);
  if (denied) return { ok: false, message: denied };
  try {
    const data = await call(parsed.data);
    if (reload) refresh();
    return { ok: true, data };
  } catch (err) {
    return { ok: false, message: describeApiError(err) };
  }
}

const Id = z.uuid();
const Zone = z.string().trim().regex(/^[A-Za-z0-9-]{1,20}$/, 'letters, digits and dashes only').nullable();
const Region = z.string().trim().min(1).max(40).nullable();
const Settings = z.record(z.string(), z.unknown());
const Secret = z.string().min(1).max(16_000);

const ProviderCreate = z.object({
  kind: z.enum(PROVIDER_KINDS),
  name: z.string().trim().min(1, 'Enter a name').max(80),
  region: Region,
  residencyZone: Zone,
  settings: Settings,
  credentials: z.record(z.string(), Secret),
  enabled: z.boolean(),
  maxConcurrency: z.number().int().min(1).max(10_000),
});
const ProviderUpdate = ProviderCreate.omit({ kind: true, credentials: true }).extend({ credentials: z.record(z.string(), Secret.nullable()) });

export async function createProviderAction(input: z.input<typeof ProviderCreate>): Promise<ActionResult<{ id: string; name: string }>> {
  return run(Permission.PROVIDERS_MANAGE, 'add model providers', ProviderCreate, input, async (body) => {
    const p = await createProvider(body);
    return { id: p.id, name: p.name };
  });
}

export async function updateProviderAction(id: string, input: z.input<typeof ProviderUpdate>): Promise<ActionResult<{ name: string }>> {
  return run(Permission.PROVIDERS_MANAGE, 'change model providers', z.object({ id: Id, body: ProviderUpdate }), { id, body: input }, async ({ id: pid, body }) => {
    const p = await updateProvider(pid, body);
    return { name: p.name };
  });
}

export async function deleteProviderAction(id: string): Promise<ActionResult> {
  return run(Permission.PROVIDERS_MANAGE, 'remove model providers', Id, id, async (pid) => {
    await deleteProvider(pid);
    return null;
  });
}

/** "Test connection": health probe plus a tiny generation (POST /v1/model-providers/:id/test). */
export async function testProviderAction(id: string, model: string | null): Promise<ActionResult<ProviderTestResult>> {
  const Input = z.object({ id: Id, model: z.string().trim().min(1).max(200).nullable() });
  return run(Permission.PROVIDERS_MANAGE, 'test model providers', Input, { id, model: model?.trim() || null }, (i) => testProvider(i.id, i.model));
}

const ProfileInput = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]{1,48}$/, 'lowercase letters, digits and dashes; starts with a letter; 2–49 characters'),
  description: z.string().trim().max(500).nullable(),
  providerId: Id,
  model: z.string().trim().min(1, 'Enter the model or deployment id').max(200),
  temperature: z.number().min(0).max(2).nullable(),
  maxOutputTokens: z.number().int().min(1).max(200_000),
  reasoning: z.enum(['none', 'low', 'medium', 'high']).nullable(),
  timeoutMs: z.number().int().min(1_000).max(600_000),
  retries: z.number().int().min(0).max(5),
  retryBackoffMs: z.number().int().min(0).max(60_000),
  cachePolicy: z.enum(['OFF', 'PREFIX']),
  cacheTtl: z.enum(['5m', '1h']).nullable(),
  fallbacks: z.array(z.object({ providerId: Id, model: z.string().trim().min(1).max(200) })).max(5),
  requiredCapabilities: z.partialRecord(z.enum(CAPABILITY_KEYS), z.boolean()),
});
type ProfileInputT = z.input<typeof ProfileInput>;

/** Dry-run policy check (residency, allowlist, fallback rules, capabilities) before saving. */
export async function validateProfileAction(input: ProfileInputT): Promise<ActionResult<PolicyCheck>> {
  return run(Permission.MODEL_PROFILES_MANAGE, 'change model profiles', ProfileInput, input, validateProfile, false);
}

export async function saveProfileAction(id: string | null, input: ProfileInputT): Promise<ActionResult<ProfileSaveResult>> {
  const Input = z.object({ id: Id.nullable(), body: ProfileInput });
  return run(Permission.MODEL_PROFILES_MANAGE, 'change model profiles', Input, { id, body: input }, (i) => (i.id ? updateProfile(i.id, i.body) : createProfile(i.body)));
}

export async function deleteProfileAction(id: string): Promise<ActionResult> {
  return run(Permission.MODEL_PROFILES_MANAGE, 'remove model profiles', Id, id, async (pid) => {
    await deleteProfile(pid);
    return null;
  });
}

const Micros = z.number().int().min(0).max(1_000_000_000_000);
const PricingInput = z.object({
  providerKind: z.enum(PROVIDER_KINDS),
  modelPattern: z.string().trim().min(1, 'Enter a model id or a prefix ending in *').max(200),
  currency: z.string().regex(/^[A-Z]{3}$/, 'three-letter currency code, e.g. USD'),
  inputPerMTokMicros: Micros,
  cachedInputPerMTokMicros: Micros.nullable(),
  cacheWritePerMTokMicros: Micros.nullable(),
  outputPerMTokMicros: Micros,
});

export async function savePricingAction(id: string | null, input: z.input<typeof PricingInput>): Promise<ActionResult> {
  const Input = z.object({ id: Id.nullable(), body: PricingInput });
  return run(Permission.PRICING_MANAGE, 'change model pricing', Input, { id, body: input }, async (i) => {
    await (i.id ? updatePricing(i.id, i.body) : createPricing(i.body));
    return null;
  });
}

export async function deletePricingAction(id: string): Promise<ActionResult> {
  return run(Permission.PRICING_MANAGE, 'change model pricing', Id, id, async (pid) => {
    await deletePricing(pid);
    return null;
  });
}
