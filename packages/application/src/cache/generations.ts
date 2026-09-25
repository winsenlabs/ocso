import { inArray, sql } from 'drizzle-orm';
import { cacheGenerations, type DbOrTx } from '@ocso/db';
import { emitEvent } from '../events/outbox.js';

/**
 * Cache invalidation by monotonic generation counters (docs/archive/specs/05 §5). Derived
 * caches record the generations they were built from; any bump makes them
 * stale everywhere, and an event lets hot workers drop entries immediately.
 */
export type CacheScope =
  | `agent:${string}`
  | `profile:${string}`
  | `customer:${string}`
  | `channel:${string}`
  | `connection:${string}`
  | 'policy'
  | 'global';

export type InvalidationReason =
  | 'prompt_activated'
  | 'tools_changed'
  | 'policy_changed'
  | 'customer_context_changed'
  | 'model_config_changed'
  | 'channel_behavior_changed'
  | 'agent_config_changed';

export async function bumpGeneration(tx: DbOrTx, correlationId: string, scope: CacheScope, reason: InvalidationReason): Promise<number> {
  const [row] = await tx
    .insert(cacheGenerations)
    .values({ scope, generation: 2, reason })
    .onConflictDoUpdate({
      target: cacheGenerations.scope,
      set: { generation: sql`${cacheGenerations.generation} + 1`, reason, updatedAt: new Date() },
    })
    .returning({ generation: cacheGenerations.generation });
  await emitEvent(tx, { correlationId }, 'cache.invalidated', { scope, key: null, reason });
  return row!.generation;
}

/** Current generations for a set of scopes (missing scopes are generation 1). */
export async function readGenerations(db: DbOrTx, scopes: readonly CacheScope[]): Promise<Record<string, number>> {
  if (!scopes.length) return {};
  const rows = await db.select().from(cacheGenerations).where(inArray(cacheGenerations.scope, [...scopes]));
  const found = new Map(rows.map((r) => [r.scope, r.generation]));
  return Object.fromEntries(scopes.map((s) => [s, found.get(s) ?? 1]));
}
