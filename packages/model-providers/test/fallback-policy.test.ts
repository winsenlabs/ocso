import { describe, expect, it } from 'vitest';
import { DomainError } from '@ocso/domain';
import { mayFallBack, planTargets, type DeploymentModelPolicy, type ModelTargetCandidate } from '../src/policy/fallback-policy.js';
import { cacheHitRatio, normalizeUsage } from '../src/core/usage.js';
import type { ModelCapabilities } from '../src/contract/types.js';

const caps = (over: Partial<ModelCapabilities> = {}): ModelCapabilities => ({
  imageInput: true,
  fileInput: true,
  audioInput: false,
  toolCalling: true,
  structuredOutput: true,
  reasoning: false,
  streaming: true,
  promptCaching: 'EXPLICIT',
  reportsCacheWrites: true,
  ...over,
});

const target = (providerId: string, over: Partial<ModelTargetCandidate> = {}): ModelTargetCandidate => ({
  providerId,
  providerKind: 'BEDROCK',
  providerEnabled: true,
  model: 'm',
  region: 'ap-south-1',
  residencyZone: 'IN',
  capabilities: caps(),
  ...over,
});

const policy = (over: Partial<DeploymentModelPolicy> = {}): DeploymentModelPolicy => ({
  providerAllowlist: ['bedrock', 'anthropic', 'vertex', 'sarvam'],
  requiredResidencyZone: 'IN',
  allowCrossProviderFallback: true,
  allowCrossRegionFallback: true,
  ...over,
});

describe('fallback policy (docs/06 §5)', () => {
  const primary = target('bedrock');

  it('keeps permitted fallbacks in order', () => {
    const plan = planTargets(primary, [target('vertex', { region: 'asia-south1' }), target('sarvam')], policy(), {});
    expect(plan.allowed.map((t) => t.providerId)).toEqual(['bedrock', 'vertex', 'sarvam']);
  });

  it('never silently violates data residency', () => {
    const plan = planTargets(primary, [target('anthropic', { residencyZone: 'GLOBAL', region: null })], policy(), {});
    expect(plan.allowed.map((t) => t.providerId)).toEqual(['bedrock']);
    expect(plan.rejected[0]?.reason).toBe('residency_violation');
  });

  it('respects the provider allowlist and disabled providers', () => {
    const plan = planTargets(primary, [target('openai'), target('vertex', { providerEnabled: false })], policy(), {});
    expect(plan.rejected.map((r) => r.reason)).toEqual(['provider_not_allowlisted', 'provider_disabled']);
  });

  it('honours cross-provider and cross-region prohibitions', () => {
    const noCross = planTargets(primary, [target('vertex')], policy({ allowCrossProviderFallback: false }), {});
    expect(noCross.rejected[0]?.reason).toBe('cross_provider_forbidden');
    const noRegion = planTargets(primary, [target('bedrock', { region: 'ap-southeast-1' })], policy({ allowCrossRegionFallback: false }), {});
    expect(noRegion.rejected[0]?.reason).toBe('cross_region_forbidden');
  });

  it('rejects targets missing required capabilities', () => {
    const plan = planTargets(primary, [target('sarvam', { capabilities: caps({ imageInput: false }) })], policy(), { imageInput: true });
    expect(plan.rejected[0]?.reason).toBe('missing_capability:imageInput');
  });

  it('rejects targets above the cost ceiling', () => {
    const plan = planTargets(primary, [target('vertex', { outputCostPerMTokMicros: 90_000_000 })], policy({ maxOutputCostPerMTokMicros: 20_000_000 }), {});
    expect(plan.rejected[0]?.reason).toBe('cost_ceiling_exceeded');
  });

  it('flags a misconfigured primary instead of using it', () => {
    const plan = planTargets(target('openai'), [], policy(), {});
    expect(plan.allowed).toEqual([]);
  });

  it('falls back only on retriable errors before customer-visible output', () => {
    const throttled = new DomainError('provider_rate_limited', 'throttled', 'x');
    const denied = new DomainError('policy_denied', 'nope', 'x');
    expect(mayFallBack(throttled, false)).toBe(true);
    expect(mayFallBack(throttled, true)).toBe(false);
    expect(mayFallBack(denied, false)).toBe(false);
    expect(mayFallBack(new DomainError('timeout', 't', 'x'), false)).toBe(true);
  });
});

describe('usage normalization', () => {
  it('maps AI SDK usage details and keeps unreported cache writes null', () => {
    const u = normalizeUsage(
      { inputTokens: 1200, outputTokens: 30, inputTokenDetails: { noCacheTokens: 200, cacheReadTokens: 1000 } },
      { reportsCacheReads: true, reportsCacheWrites: false },
    );
    expect(u).toEqual({
      inputTokens: 1200,
      uncachedInputTokens: 200,
      cachedInputTokens: 1000,
      cacheWriteTokens: null,
      outputTokens: 30,
      reasoningTokens: null,
    });
    expect(cacheHitRatio(u)).toBeCloseTo(0.8333, 3);
  });

  it('treats missing cache reads as unreported for providers without cache metrics', () => {
    const u = normalizeUsage({ inputTokens: 100, outputTokens: 5 }, { reportsCacheReads: false, reportsCacheWrites: false });
    expect(u.cachedInputTokens).toBeNull();
    expect(cacheHitRatio(u)).toBeNull();
  });
});
