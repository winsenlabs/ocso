import { asc, desc, eq } from 'drizzle-orm';
import { Permission } from '@ocso/auth';
import { notFound } from '@ocso/domain';
import { modelPricing, uuidv7, type Db, type DbOrTx } from '@ocso/db';
import { recordAudit } from '../audit/audit.js';
import { emitEvent } from '../events/outbox.js';
import type { ActorContext } from '../shared/context.js';
import { authorize } from './access.js';
import type { PricingInput, PricingPatch } from './inputs.js';

export type PricingRow = typeof modelPricing.$inferSelect;

/**
 * Same matching rule as the usage recorder: an exact model id, or a prefix
 * (trailing `*` optional). The most recent effective row wins.
 */
export function findPrice(rows: readonly PricingRow[], providerKind: string, model: string, now: Date): PricingRow | undefined {
  return [...rows]
    .filter((p) => p.effectiveFrom.getTime() <= now.getTime())
    .sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime())
    .find((p) => p.providerKind === providerKind && (model === p.modelPattern || model.startsWith(p.modelPattern.replace(/\*$/, ''))));
}

export async function loadPricing(db: DbOrTx): Promise<PricingRow[]> {
  return db.select().from(modelPricing).orderBy(desc(modelPricing.effectiveFrom));
}

/** Tech-Admin-maintained price table used for usage cost metadata (docs/05 §3). */
export class PricingService {
  constructor(private readonly db: Db) {}

  async list(actor: ActorContext): Promise<PricingRow[]> {
    authorize(actor, Permission.PRICING_MANAGE);
    return this.db.select().from(modelPricing).orderBy(asc(modelPricing.providerKind), asc(modelPricing.modelPattern), desc(modelPricing.effectiveFrom));
  }

  async create(actor: ActorContext, input: PricingInput): Promise<PricingRow> {
    authorize(actor, Permission.PRICING_MANAGE);
    const id = uuidv7();
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(modelPricing)
        .values({
          id,
          providerKind: input.providerKind,
          modelPattern: input.modelPattern,
          currency: input.currency,
          inputPerMTokMicros: input.inputPerMTokMicros,
          cachedInputPerMTokMicros: input.cachedInputPerMTokMicros,
          cacheWritePerMTokMicros: input.cacheWritePerMTokMicros,
          outputPerMTokMicros: input.outputPerMTokMicros,
          ...(input.effectiveFrom ? { effectiveFrom: new Date(input.effectiveFrom) } : {}),
        })
        .returning();
      await recordAudit(tx, actor, {
        action: 'model_pricing.create',
        targetType: 'model_pricing',
        targetId: id,
        summary: `Added pricing for ${input.providerKind} ${input.modelPattern}`,
        after: input,
      });
      await emitEvent(tx, actor, 'config.changed', { area: 'model_pricing', entityId: id });
      return row!;
    });
  }

  async update(actor: ActorContext, id: string, patch: PricingPatch): Promise<PricingRow> {
    authorize(actor, Permission.PRICING_MANAGE);
    return this.db.transaction(async (tx) => {
      const [before] = await tx.select().from(modelPricing).where(eq(modelPricing.id, id)).for('update');
      if (!before) throw notFound('model_pricing', id);
      const { effectiveFrom, ...fields } = patch;
      const set = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
      const [after] = await tx
        .update(modelPricing)
        .set({ ...set, ...(effectiveFrom ? { effectiveFrom: new Date(effectiveFrom) } : {}) })
        .where(eq(modelPricing.id, id))
        .returning();
      await recordAudit(tx, actor, {
        action: 'model_pricing.update',
        targetType: 'model_pricing',
        targetId: id,
        summary: `Updated pricing for ${before.providerKind} ${before.modelPattern}`,
        before,
        after: patch,
      });
      await emitEvent(tx, actor, 'config.changed', { area: 'model_pricing', entityId: id });
      return after!;
    });
  }

  async delete(actor: ActorContext, id: string): Promise<void> {
    authorize(actor, Permission.PRICING_MANAGE);
    await this.db.transaction(async (tx) => {
      const [before] = await tx.delete(modelPricing).where(eq(modelPricing.id, id)).returning();
      if (!before) throw notFound('model_pricing', id);
      await recordAudit(tx, actor, {
        action: 'model_pricing.delete',
        targetType: 'model_pricing',
        targetId: id,
        summary: `Removed pricing for ${before.providerKind} ${before.modelPattern}`,
        before,
      });
      await emitEvent(tx, actor, 'config.changed', { area: 'model_pricing', entityId: id });
    });
  }
}
