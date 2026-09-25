import { sql } from 'drizzle-orm';
import type { ActorContext } from '@ocso/application';
import { modelProfiles, modelProviders } from '@ocso/db';
import type { SeedContext } from '../context.js';
import { approveAs, isApproved } from './agents.js';
import { DEV_PROVIDER, PROFILES, type ProfileKey } from '../data/organization.js';

/**
 * DEV_SCRIPTED provider + logical profiles (ADR-015, docs/archive/specs/06 §2) through
 * ProviderService/ProfileService, so the save-time residency check runs
 * against the IN residency zone exactly as it would for a real provider.
 */
export async function seedModels(ctx: SeedContext, admin: ActorContext, checker: ActorContext): Promise<Record<ProfileKey, string>> {
  const [existingProvider] = await ctx.db
    .select({ id: modelProviders.id, name: modelProviders.name })
    .from(modelProviders)
    .where(sql`lower(${modelProviders.name}) = lower(${DEV_PROVIDER.name})`);
  const providerId =
    existingProvider?.id ??
    (
      await ctx.services.providers.create(admin, {
        kind: 'DEV_SCRIPTED',
        name: DEV_PROVIDER.name,
        region: DEV_PROVIDER.region,
        residencyZone: DEV_PROVIDER.residencyZone,
        settings: { ...DEV_PROVIDER.settings },
        credentials: {},
        enabled: false,
        maxConcurrency: 50,
      })
    ).id;
  if (!(await isApproved(ctx, 'model_provider', providerId))) {
    // A new provider is a disabled draft: enabling it is approved by a second person (PM/research/11 §4).
    await approveAs(ctx, admin, checker, { objectKind: 'model_provider', objectId: providerId, action: 'ACTIVATE' }, 'Demo seed: enable the scripted provider');
    ctx.log(`created DEV_SCRIPTED provider "${DEV_PROVIDER.name}" (development only), enabled with approval`);
  }

  const existingProfiles = await ctx.db.select({ id: modelProfiles.id, name: modelProfiles.name }).from(modelProfiles);
  const ids = {} as Record<ProfileKey, string>;
  // Fallback targets must exist first: create profiles without fallbacks before those with one.
  const order = (Object.keys(PROFILES) as ProfileKey[]).sort((a, b) => Number(Boolean(PROFILES[a].fallbackTo)) - Number(Boolean(PROFILES[b].fallbackTo)));
  for (const key of order) {
    const profile = PROFILES[key];
    const found = existingProfiles.find((p) => p.name === profile.name);
    if (found) {
      ids[key] = found.id;
      // Created by an interrupted run before its approval went through.
      if (!(await isApproved(ctx, 'model_profile', found.id))) {
        await approveAs(ctx, admin, checker, { objectKind: 'model_profile', objectId: found.id, action: 'ACTIVATE' }, 'Demo seed: approve the profile for use');
      }
      continue;
    }
    const fallback = profile.fallbackTo ? [{ providerId, model: PROFILES[profile.fallbackTo].model }] : [];
    const saved = await ctx.services.profiles.create(admin, {
      name: profile.name,
      description: profile.description,
      providerId,
      model: profile.model,
      temperature: profile.temperature,
      maxOutputTokens: profile.maxOutputTokens,
      reasoning: null,
      timeoutMs: 30_000,
      retries: 1,
      retryBackoffMs: 400,
      cachePolicy: 'PREFIX',
      cacheTtl: '5m',
      fallbacks: fallback,
      requiredCapabilities: { toolCalling: true, streaming: true },
    });
    ids[key] = saved.id;
    await approveAs(ctx, admin, checker, { objectKind: 'model_profile', objectId: saved.id, action: 'ACTIVATE' }, 'Demo seed: approve the profile for use');
    ctx.log(`created model profile ${profile.name} → ${profile.model} (${saved.policy.message}), approved for use`);
  }
  return ids;
}
