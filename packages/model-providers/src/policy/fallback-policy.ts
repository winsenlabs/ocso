import { ErrorCategory, RETRIABLE_CATEGORIES, type DomainError } from '@ocso/domain';
import type { ModelCapabilities, ProviderKind } from '../contract/types.js';

/**
 * Fallback is policy, not magic (docs/archive/specs/06 §5). This module is pure: it decides
 * which targets a request may use, and when a failure may move to the next one.
 */

export interface ModelTargetCandidate {
  providerId: string;
  providerKind: ProviderKind;
  providerEnabled: boolean;
  model: string;
  region: string | null;
  /** Data-residency zone the provider keeps data in, e.g. `IN`, `EU`, `GLOBAL`. */
  residencyZone: string | null;
  capabilities: ModelCapabilities;
  /** Estimated cost per 1M output tokens in micro-units of the deployment currency. */
  outputCostPerMTokMicros?: number | undefined;
}

export interface DeploymentModelPolicy {
  /** Provider ids allowed at all. Empty = none allowed. */
  providerAllowlist: readonly string[];
  /** When set, every target must keep data in this zone. */
  requiredResidencyZone: string | null;
  allowCrossProviderFallback: boolean;
  allowCrossRegionFallback: boolean;
  maxOutputCostPerMTokMicros?: number | undefined;
}

export type CapabilityRequirement = Partial<
  Pick<ModelCapabilities, 'imageInput' | 'fileInput' | 'audioInput' | 'toolCalling' | 'structuredOutput' | 'streaming'>
>;

export type RejectionReason =
  | 'provider_disabled'
  | 'provider_not_allowlisted'
  | 'residency_violation'
  | 'cross_provider_forbidden'
  | 'cross_region_forbidden'
  | `missing_capability:${string}`
  | 'cost_ceiling_exceeded';

export interface CandidatePlan {
  allowed: ModelTargetCandidate[];
  rejected: Array<{ candidate: ModelTargetCandidate; reason: RejectionReason }>;
}

function rejectionFor(
  c: ModelTargetCandidate,
  primary: ModelTargetCandidate,
  isPrimary: boolean,
  policy: DeploymentModelPolicy,
  required: CapabilityRequirement,
): RejectionReason | null {
  if (!c.providerEnabled) return 'provider_disabled';
  if (!policy.providerAllowlist.includes(c.providerId)) return 'provider_not_allowlisted';
  if (policy.requiredResidencyZone && c.residencyZone !== policy.requiredResidencyZone) {
    return 'residency_violation';
  }
  if (!isPrimary) {
    if (!policy.allowCrossProviderFallback && c.providerId !== primary.providerId) return 'cross_provider_forbidden';
    if (!policy.allowCrossRegionFallback && c.region !== primary.region) return 'cross_region_forbidden';
  }
  for (const [cap, needed] of Object.entries(required)) {
    if (needed && !c.capabilities[cap as keyof ModelCapabilities]) return `missing_capability:${cap}`;
  }
  if (
    policy.maxOutputCostPerMTokMicros !== undefined &&
    c.outputCostPerMTokMicros !== undefined &&
    c.outputCostPerMTokMicros > policy.maxOutputCostPerMTokMicros
  ) {
    return 'cost_ceiling_exceeded';
  }
  return null;
}

/** Ordered list of targets the request may use: primary first, then permitted fallbacks. */
export function planTargets(
  primary: ModelTargetCandidate,
  fallbacks: readonly ModelTargetCandidate[],
  policy: DeploymentModelPolicy,
  required: CapabilityRequirement,
): CandidatePlan {
  const plan: CandidatePlan = { allowed: [], rejected: [] };
  [primary, ...fallbacks].forEach((candidate, index) => {
    const reason = rejectionFor(candidate, primary, index === 0, policy, required);
    if (reason) plan.rejected.push({ candidate, reason });
    else plan.allowed.push(candidate);
  });
  return plan;
}

/**
 * A failed attempt may move to the next target only when the error is
 * retriable AND no customer-visible output has been emitted yet.
 */
export function mayFallBack(error: DomainError, customerVisibleOutputStarted: boolean): boolean {
  if (customerVisibleOutputStarted) return false;
  if (error.category === ErrorCategory.POLICY_DENIED || error.category === ErrorCategory.VALIDATION) return false;
  return RETRIABLE_CATEGORIES.has(error.category);
}
