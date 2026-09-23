import { eq, inArray } from 'drizzle-orm';
import { DomainError, isDomainError, policyDenied } from '@ocso/domain';
import { modelProfiles, modelProviders, type Db } from '@ocso/db';
import {
  mayFallBack,
  planTargets,
  type CapabilityRequirement,
  type DeploymentModelPolicy,
  type ModelProviderAdapter,
  type ModelRequest,
  type ModelResult,
  type ModelTargetCandidate,
} from '@ocso/model-providers';
import { recordAudit, emitEvent, systemActor, SettingsService } from '@ocso/application';
import { Semaphore } from './semaphore.js';
import { UsageRecorder, type UsageContext } from './usage-recorder.js';

/** Supplies a ready adapter for a provider (config + resolved credentials). */
export interface ProviderAdapterSource {
  get(providerId: string): Promise<ModelProviderAdapter>;
}

export interface GatewayRequest {
  profileId: string;
  purpose: ModelRequest['purpose'];
  system: ModelRequest['system'];
  messages: ModelRequest['messages'];
  tools: ModelRequest['tools'];
  toolChoice?: ModelRequest['toolChoice'];
  responseSchema?: ModelRequest['responseSchema'];
  abortSignal?: AbortSignal | undefined;
  /** Stable cache key for key-routed providers (agent prefix hash). */
  cacheKey?: string | undefined;
  required?: CapabilityRequirement | undefined;
  context: UsageContext;
  /** Receives streamed text; once called, fallback is no longer allowed. */
  onTextDelta?: ((text: string) => void) | undefined;
}

export interface GatewayResult extends ModelResult {
  profileId: string;
  usageEventId: string;
  fellBack: boolean;
}

type ProfileRow = typeof modelProfiles.$inferSelect;
type ProviderRow = typeof modelProviders.$inferSelect;

/**
 * Logical profile → provider execution with policy-bound fallback (docs/06 §5).
 * Every attempt (success or failure) produces a usage event; every fallback is
 * observable (event) and auditable (audit record).
 */
export class ModelGateway {
  private readonly semaphores = new Map<string, Semaphore>();
  private readonly concurrency = new Map<string, number>();

  constructor(
    private readonly db: Db,
    private readonly adapters: ProviderAdapterSource,
    private readonly usage: UsageRecorder,
    private readonly settings: SettingsService,
  ) {}

  async run(req: GatewayRequest): Promise<GatewayResult> {
    const [profile] = await this.db.select().from(modelProfiles).where(eq(modelProfiles.id, req.profileId));
    if (!profile) throw new DomainError('validation', 'profile_not_found', 'Model profile not found');
    const plan = await this.plan(profile, req.required ?? {});
    if (!plan.allowed.length) {
      throw policyDenied('no_permitted_model_target', 'No provider target satisfies the deployment model policy', {
        rejected: plan.rejected.map((r) => `${r.candidate.providerId}:${r.reason}`),
      });
    }
    let streamed = false;
    let lastError: DomainError | null = null;
    let previous: ModelTargetCandidate | null = null;
    for (const target of plan.allowed) {
      if (previous) await this.recordFallback(req, profile, previous, target, lastError);
      for (let attempt = 1; attempt <= Math.max(1, profile.retries + 1); attempt++) {
        try {
          const result = await this.attempt(profile, target, req, () => (streamed = true));
          const usageEventId = await this.usage.record(req.context, profile, target, attempt, previous?.providerId ?? null, result, null);
          return { ...result, profileId: profile.id, usageEventId, fellBack: previous !== null };
        } catch (err) {
          const error = isDomainError(err) ? err : new DomainError('internal', 'model_call_failed', 'Model call failed');
          await this.usage.record(req.context, profile, target, attempt, previous?.providerId ?? null, null, error);
          lastError = error;
          if (req.abortSignal?.aborted) throw error;
          if (!mayFallBack(error, streamed)) throw error;
          if (attempt <= profile.retries) await sleep(profile.retryBackoffMs * attempt);
        }
      }
      previous = target;
    }
    throw lastError ?? new DomainError('provider_unavailable', 'all_targets_failed', 'All model targets failed');
  }

  private async attempt(profile: ProfileRow, target: ModelTargetCandidate, req: GatewayRequest, onStream: () => void): Promise<ModelResult> {
    const adapter = await this.adapters.get(target.providerId);
    const semaphore = this.semaphoreFor(target.providerId, this.concurrency.get(target.providerId) ?? 50);
    return semaphore.run(async () => {
      const request: ModelRequest = {
        purpose: req.purpose,
        system: req.system,
        messages: req.messages,
        tools: req.tools,
        ...(req.toolChoice ? { toolChoice: req.toolChoice } : {}),
        ...(profile.temperature !== null ? { temperature: profile.temperature } : {}),
        maxOutputTokens: profile.maxOutputTokens,
        ...(profile.reasoning ? { reasoning: profile.reasoning } : {}),
        timeoutMs: profile.timeoutMs,
        abortSignal: req.abortSignal,
        cache: { policy: profile.cachePolicy, ttl: profile.cacheTtl ?? undefined, key: req.cacheKey },
        responseSchema: req.responseSchema,
      };
      if (!req.onTextDelta) return adapter.generate(request, target.model);
      let final: ModelResult | null = null;
      for await (const event of adapter.stream(request, target.model)) {
        if (event.type === 'text-delta') {
          onStream();
          req.onTextDelta(event.text);
        } else if (event.type === 'finish') final = event.result;
      }
      if (!final) throw new DomainError('provider_unavailable', 'stream_incomplete', 'Model stream ended without a result');
      return final;
    });
  }

  private async plan(profile: ProfileRow, required: CapabilityRequirement) {
    const targets = [{ providerId: profile.providerId, model: profile.model }, ...profile.fallbacks];
    const providers = await this.db.select().from(modelProviders).where(inArray(modelProviders.id, [...new Set(targets.map((t) => t.providerId))]));
    const byId = new Map(providers.map((p) => [p.id, p]));
    for (const p of providers) this.concurrency.set(p.id, p.maxConcurrency);
    const candidates: ModelTargetCandidate[] = [];
    for (const t of targets) {
      const provider = byId.get(t.providerId);
      if (!provider) continue;
      candidates.push(await this.candidate(provider, t.model));
    }
    const settings = await this.settings.deployment();
    const policy: DeploymentModelPolicy = {
      providerAllowlist: settings.providerAllowlist.length ? settings.providerAllowlist : providers.map((p) => p.id),
      requiredResidencyZone: settings.residencyZone,
      allowCrossProviderFallback: settings.allowCrossProviderFallback,
      allowCrossRegionFallback: settings.allowCrossRegionFallback,
      maxOutputCostPerMTokMicros: settings.maxOutputCostPerMTokMicros ?? undefined,
    };
    const [primary, ...fallbacks] = candidates;
    if (!primary) return { allowed: [], rejected: [] };
    return planTargets(primary, fallbacks, policy, required);
  }

  private async candidate(provider: ProviderRow, model: string): Promise<ModelTargetCandidate> {
    let capabilities;
    try {
      capabilities = (await this.adapters.get(provider.id)).capabilities(model);
    } catch {
      capabilities = { imageInput: false, fileInput: false, audioInput: false, toolCalling: false, structuredOutput: false, reasoning: false, streaming: false, promptCaching: 'UNSUPPORTED' as const, reportsCacheWrites: false };
    }
    return {
      providerId: provider.id,
      providerKind: provider.kind,
      providerEnabled: provider.enabled,
      model,
      region: provider.region,
      residencyZone: provider.residencyZone,
      capabilities,
    };
  }

  private async recordFallback(req: GatewayRequest, profile: ProfileRow, from: ModelTargetCandidate, to: ModelTargetCandidate, error: DomainError | null): Promise<void> {
    const actor = systemActor('model-gateway', req.context.correlationId);
    await this.db.transaction(async (tx) => {
      await emitEvent(tx, actor, 'model.fallback', {
        turnId: req.context.turnId ?? null,
        profileId: profile.id,
        fromProviderId: from.providerId,
        toProviderId: to.providerId,
        reason: error?.code ?? 'unknown',
      }, { conversationId: req.context.conversationId ?? null, agentId: req.context.agentId ?? null });
      await recordAudit(tx, actor, {
        action: 'model.fallback',
        targetType: 'model_profile',
        targetId: profile.id,
        summary: `${profile.name}: ${from.providerKind}/${from.model} → ${to.providerKind}/${to.model} after ${error?.category ?? 'error'}`,
      });
    });
  }

  private semaphoreFor(providerId: string, max: number): Semaphore {
    let s = this.semaphores.get(providerId);
    if (!s) this.semaphores.set(providerId, (s = new Semaphore(max)));
    return s;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
