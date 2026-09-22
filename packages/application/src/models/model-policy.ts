import { eq, inArray } from 'drizzle-orm';
import { validation } from '@ocso/domain';
import { deploymentSettings, modelProviders, type DbOrTx } from '@ocso/db';
import {
  planTargets,
  type CapabilityRequirement,
  type DeploymentModelPolicy,
  type ModelCapabilities,
  type ModelTargetCandidate,
  type ProviderKind,
  type ProviderRegistry,
} from '@ocso/model-providers';
import { parseSettings, type ProviderRow } from './provider-config.js';
import { findPrice, loadPricing } from './pricing-service.js';
import { targetReasonText } from './policy-text.js';

/**
 * Save-time evaluation of a profile's targets against the deployment model
 * policy, using the same pure planner the runtime gateway uses (docs/06 §5).
 * The primary must be permitted; rejected fallbacks become warnings.
 */

export interface TargetCheck {
  providerId: string;
  providerName: string;
  providerKind: ProviderKind;
  model: string;
  region: string | null;
  residencyZone: string | null;
  permitted: boolean;
  reason: string | null;
  capabilities: ModelCapabilities | null;
}

export interface ProfilePolicyCheck {
  ok: boolean;
  primary: TargetCheck;
  fallbacks: TargetCheck[];
  warnings: string[];
  /** One-line summary for the "residency check" box in the profile dialog. */
  message: string;
  policy: {
    residencyZone: string | null;
    /** Empty = every configured provider is allowed (same rule as the gateway). */
    providerAllowlist: string[];
    allowCrossProviderFallback: boolean;
    allowCrossRegionFallback: boolean;
  };
}

export interface ProfileTargets {
  providerId: string;
  model: string;
  fallbacks: ReadonlyArray<{ providerId: string; model: string }>;
  requiredCapabilities: CapabilityRequirement;
}

const NO_CAPABILITIES: ModelCapabilities = {
  imageInput: false,
  fileInput: false,
  audioInput: false,
  toolCalling: false,
  structuredOutput: false,
  reasoning: false,
  streaming: false,
  promptCaching: 'UNSUPPORTED',
  reportsCacheWrites: false,
};

function capabilitiesOf(registry: ProviderRegistry, provider: ProviderRow, model: string): ModelCapabilities | null {
  const definition = registry.get(provider.kind);
  if (!definition) return null;
  try {
    return definition.capabilities(model, parseSettings(definition, provider.settings));
  } catch {
    return null;
  }
}

function assertDistinctTargets(targets: ProfileTargets): void {
  const seen = new Set<string>();
  for (const t of [targets, ...targets.fallbacks]) {
    const key = `${t.providerId}\u0000${t.model}`;
    if (seen.has(key)) throw validation('duplicate_fallback_target', `Target ${t.model} is listed more than once`);
    seen.add(key);
  }
}

export async function checkProfileTargets(db: DbOrTx, registry: ProviderRegistry, targets: ProfileTargets, now: Date): Promise<ProfilePolicyCheck> {
  assertDistinctTargets(targets);
  const ids = [...new Set([targets.providerId, ...targets.fallbacks.map((f) => f.providerId)])];
  // FOR SHARE: inside a save transaction, a concurrent provider delete waits for this profile write.
  const rows = await db.select().from(modelProviders).where(inArray(modelProviders.id, ids)).for('share');
  const providers = new Map(rows.map((p) => [p.id, p]));
  if (!providers.has(targets.providerId)) {
    throw validation('provider_not_found', 'The selected model provider does not exist', { providerId: targets.providerId });
  }
  const missing = targets.fallbacks.filter((f) => !providers.has(f.providerId)).map((f) => f.providerId);
  if (missing.length) throw validation('fallback_provider_not_found', 'A fallback references a provider that does not exist', { providerIds: missing });

  const [settings] = await db.select().from(deploymentSettings).where(eq(deploymentSettings.id, 1));
  const policy: DeploymentModelPolicy = {
    providerAllowlist: settings?.providerAllowlist.length ? settings.providerAllowlist : ids,
    requiredResidencyZone: settings?.residencyZone ?? null,
    allowCrossProviderFallback: settings?.allowCrossProviderFallback ?? false,
    allowCrossRegionFallback: settings?.allowCrossRegionFallback ?? false,
    maxOutputCostPerMTokMicros: settings?.maxOutputCostPerMTokMicros ?? undefined,
  };
  const pricing = policy.maxOutputCostPerMTokMicros !== undefined ? await loadPricing(db) : [];

  const unavailable = new Set<ModelTargetCandidate>();
  const toCandidate = (t: { providerId: string; model: string }): ModelTargetCandidate => {
    const provider = providers.get(t.providerId)!;
    const capabilities = capabilitiesOf(registry, provider, t.model);
    const price = pricing.length ? findPrice(pricing, provider.kind, t.model, now) : undefined;
    const candidate: ModelTargetCandidate = {
      providerId: provider.id,
      providerKind: provider.kind,
      // Policy is judged independently of operational state; disabled providers are warned about below.
      providerEnabled: true,
      model: t.model,
      region: provider.region,
      residencyZone: provider.residencyZone,
      capabilities: capabilities ?? NO_CAPABILITIES,
      ...(price ? { outputCostPerMTokMicros: price.outputPerMTokMicros } : {}),
    };
    if (!capabilities) unavailable.add(candidate);
    return candidate;
  };
  const primary = toCandidate(targets);
  const fallbacks = targets.fallbacks.map(toCandidate);
  const plan = planTargets(primary, fallbacks, policy, targets.requiredCapabilities);
  const rejected = new Map<ModelTargetCandidate, string>(plan.rejected.map((r) => [r.candidate, r.reason]));

  const describe = (c: ModelTargetCandidate): TargetCheck => {
    const provider = providers.get(c.providerId)!;
    const reason = unavailable.has(c)
      ? registry.get(provider.kind)
        ? 'provider_configuration_invalid'
        : 'provider_kind_not_available'
      : (rejected.get(c) ?? null);
    return {
      providerId: c.providerId,
      providerName: provider.name,
      providerKind: provider.kind,
      model: c.model,
      region: c.region,
      residencyZone: c.residencyZone,
      permitted: reason === null,
      reason,
      capabilities: unavailable.has(c) ? null : c.capabilities,
    };
  };
  const primaryCheck = describe(primary);
  const fallbackChecks = fallbacks.map(describe);
  const context = { requiredZone: policy.requiredResidencyZone };

  const warnings: string[] = [];
  for (const check of [primaryCheck, ...fallbackChecks]) {
    if (!providers.get(check.providerId)!.enabled) warnings.push(`${check.providerName} is disabled; this target is skipped until it is enabled`);
  }
  for (const check of fallbackChecks) {
    if (check.reason) warnings.push(`Fallback ${check.providerName} · ${check.model} will be skipped: ${targetReasonText(check, context)}`);
  }

  return {
    ok: primaryCheck.permitted,
    primary: primaryCheck,
    fallbacks: fallbackChecks,
    warnings,
    message: summarize(primaryCheck, fallbackChecks, context),
    policy: {
      residencyZone: policy.requiredResidencyZone,
      providerAllowlist: settings?.providerAllowlist ?? [],
      allowCrossProviderFallback: policy.allowCrossProviderFallback,
      allowCrossRegionFallback: policy.allowCrossRegionFallback,
    },
  };
}

function summarize(primary: TargetCheck, fallbacks: TargetCheck[], context: { requiredZone: string | null }): string {
  if (!primary.permitted) return `Primary target not permitted: ${targetReasonText(primary, context)}.`;
  const skipped = fallbacks.filter((f) => !f.permitted).length;
  const where = context.requiredZone ? `Residency check passed. ${skipped ? 'Permitted targets keep' : 'Every target keeps'} customer data in ${context.requiredZone}.` : 'Policy check passed.';
  return skipped ? `${where} ${skipped} fallback target${skipped === 1 ? '' : 's'} will be skipped.` : where;
}
