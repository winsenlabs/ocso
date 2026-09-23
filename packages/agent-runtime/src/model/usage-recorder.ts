import { desc } from 'drizzle-orm';
import type { DomainError } from '@ocso/domain';
import { modelPricing, modelProfiles, usageEvents, uuidv7, type Db } from '@ocso/db';
import { selectPrice, usageCostMicros, type ModelResult, type ModelTargetCandidate, type NormalizedUsage } from '@ocso/model-providers';
import { currentTraceId, ocsoMetrics } from '@ocso/observability';

export interface UsageContext {
  correlationId: string;
  conversationId?: string | null | undefined;
  turnId?: string | null | undefined;
  agentId?: string | null | undefined;
  userId?: string | null | undefined;
  purpose?: string | undefined;
}

type PricingRow = typeof modelPricing.$inferSelect;

/** Writes one normalized usage event per model request (docs/05 §3) plus OTel metrics. */
export class UsageRecorder {
  private pricing: { rows: PricingRow[]; loadedAt: number } | null = null;

  constructor(private readonly db: Db) {}

  async record(
    ctx: UsageContext,
    profile: typeof modelProfiles.$inferSelect,
    target: ModelTargetCandidate,
    attempt: number,
    fallbackFrom: string | null,
    result: ModelResult | null,
    error: DomainError | null,
  ): Promise<string> {
    const id = uuidv7();
    const usage = result?.usage;
    const cost = usage ? await this.cost(target, usage) : null;
    await this.db.insert(usageEvents).values({
      id,
      purpose: ctx.purpose ?? 'TURN',
      conversationId: ctx.conversationId ?? null,
      turnId: ctx.turnId ?? null,
      agentId: ctx.agentId ?? null,
      userId: ctx.userId ?? null,
      profileId: profile.id,
      providerId: target.providerId,
      providerKind: target.providerKind,
      model: target.model,
      region: target.region,
      inputTokens: usage?.inputTokens ?? 0,
      uncachedInputTokens: usage?.uncachedInputTokens ?? 0,
      cachedInputTokens: usage?.cachedInputTokens ?? null,
      cacheWriteTokens: usage?.cacheWriteTokens ?? null,
      outputTokens: usage?.outputTokens ?? 0,
      reasoningTokens: usage?.reasoningTokens ?? null,
      latencyMs: result?.latencyMs ?? null,
      ttftMs: result?.ttftMs ?? null,
      status: result ? 'OK' : 'ERROR',
      errorCategory: error?.category ?? null,
      fallbackFromProviderId: fallbackFrom,
      attempt,
      providerRequestId: result?.identity.requestId ?? null,
      costMicros: cost?.micros ?? null,
      currency: cost?.currency ?? null,
      traceId: currentTraceId(),
    });
    const m = ocsoMetrics();
    const attrs = { provider: target.providerKind, profile: profile.name, outcome: result ? 'ok' : (error?.category ?? 'error') };
    m.modelRequests.add(1, attrs);
    if (usage) {
      m.tokens.add(usage.inputTokens, { ...attrs, kind: 'input' });
      m.tokens.add(usage.outputTokens, { ...attrs, kind: 'output' });
      if (usage.cachedInputTokens) m.tokens.add(usage.cachedInputTokens, { ...attrs, kind: 'cache_read' });
      if (usage.cacheWriteTokens) m.tokens.add(usage.cacheWriteTokens, { ...attrs, kind: 'cache_write' });
    }
    if (result?.ttftMs) m.ttft.record(result.ttftMs / 1000, attrs);
    return id;
  }

  /**
   * Cost from model_pricing (ADR-027 rule shared with telemetry and the
   * budget alert): the row effective now that matches most specifically;
   * long-context tiers apply when the request's input exceeded their
   * threshold. No matching row → null ("no price"), never zero.
   */
  private async cost(target: ModelTargetCandidate, usage: NormalizedUsage): Promise<{ micros: number; currency: string } | null> {
    if (!this.pricing || Date.now() - this.pricing.loadedAt > 300_000) {
      this.pricing = { rows: await this.db.select().from(modelPricing).orderBy(desc(modelPricing.effectiveFrom)), loadedAt: Date.now() };
    }
    const price = selectPrice(this.pricing.rows, target.providerKind, target.model, new Date());
    if (!price) return null;
    return { micros: usageCostMicros(price, usage), currency: price.currency };
  }
}
