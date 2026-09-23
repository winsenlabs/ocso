import { and, asc, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import type { AuditRecord, AuditStore } from '@ocso/audit-store';
import { auditEvents, type Db } from '@ocso/db';
import { recordAuditIncident, resolveAuditIncidents } from './incidents.js';

type OutboxRow = typeof auditEvents.$inferSelect;

/** An outbox row as the store keeps it. */
export function outboxRecord(r: OutboxRow): AuditRecord {
  return {
    id: r.id,
    occurredAt: r.occurredAt,
    actorType: r.actorType,
    actorId: r.actorId,
    actorName: r.actorName,
    via: r.via,
    action: r.action,
    targetType: r.targetType,
    targetId: r.targetId,
    summary: r.summary,
    before: r.before ?? null,
    after: r.after ?? null,
    correlationId: r.correlationId,
    confirmation: r.confirmation ?? null,
    ip: r.ip,
    teamIds: r.teamIds,
  };
}

export interface AuditTaskLogger {
  warn(fields: Record<string, unknown>, msg: string): void;
}

/** A short, secret-free description of a store failure for incidents and logs. */
export function storeError(err: unknown): string {
  const e = err as { code?: string; message?: string };
  return `${e.code ? `${e.code}: ` : ''}${(e.message ?? String(err)).split('\n')[0]!.slice(0, 300)}`;
}

export interface ShipResult {
  shipped: number;
  /** The shipper is backing off after a failure. */
  deferred?: boolean;
  error?: string;
}

/**
 * audit-ship (PM/research/11 §6.3): oldest unshipped outbox rows → the audit
 * store (idempotent append) → `shipped_at`. A failure records a SHIP_FAILED
 * (store reachable) or STORE_DOWN incident and backs off exponentially (2 s …
 * 60 s); OCSO keeps serving — the outbox is durable and the audit screen
 * merges unshipped rows. A successful round clears both incidents whoever
 * opened them (another worker, or this one before a restart). Leader-only.
 */
export class AuditShipper {
  private failures = 0;
  private notBefore = 0;
  /** When open incidents were last cleared after a success (0 = never in this process). */
  private resolvedAt = 0;

  /** The store failed recently: the other audit tasks skip their store work until shipping recovers. */
  backingOff(now: number = this.options.now?.() ?? Date.now()): boolean {
    return now < this.notBefore;
  }

  constructor(
    private readonly db: Db,
    private readonly store: AuditStore,
    private readonly options: { batch?: number; maxRounds?: number; logger?: AuditTaskLogger; now?: () => number } = {},
  ) {}

  async ship(): Promise<ShipResult> {
    const now = this.options.now?.() ?? Date.now();
    if (now < this.notBefore) return { shipped: 0, deferred: true };
    const batch = this.options.batch ?? 500;
    let shipped = 0;
    for (let round = 0; round < (this.options.maxRounds ?? 20); round++) {
      const rows = await this.db.select().from(auditEvents).where(isNull(auditEvents.shippedAt)).orderBy(asc(auditEvents.occurredAt), asc(auditEvents.id)).limit(batch);
      if (!rows.length) break;
      try {
        await this.store.append(rows.map(outboxRecord));
      } catch (err) {
        return { shipped, error: await this.failed(err, now) };
      }
      await this.db
        .update(auditEvents)
        .set({ shippedAt: new Date() })
        .where(and(inArray(auditEvents.id, rows.map((r) => r.id)), isNull(auditEvents.shippedAt)));
      shipped += rows.length;
      if (rows.length < batch) break;
    }
    // Cheap (a partial unique index, a handful of rows): right after a failure, and at least a minute apart.
    if (this.failures || now - this.resolvedAt >= 60_000) {
      this.failures = 0;
      this.resolvedAt = now;
      await resolveAuditIncidents(this.db, ['SHIP_FAILED', 'STORE_DOWN']);
    }
    return { shipped };
  }

  private async failed(err: unknown, now: number): Promise<string> {
    this.failures++;
    this.notBefore = now + Math.min(60_000, 2_000 * 2 ** Math.min(this.failures - 1, 5));
    const health = await this.store.health().catch(() => ({ ok: false, latencyMs: 0 }));
    const error = storeError(err);
    const [pending] = await this.db.select({ n: sql<number>`count(*)::int`, oldest: sql<Date | null>`min(${auditEvents.occurredAt})` }).from(auditEvents).where(isNull(auditEvents.shippedAt));
    await recordAuditIncident(this.db, health.ok ? 'SHIP_FAILED' : 'STORE_DOWN', {
      driver: this.store.driver,
      error,
      attempts: this.failures,
      unshipped: pending?.n ?? null,
      oldestUnshipped: pending?.oldest ? new Date(pending.oldest).toISOString() : null,
    });
    this.options.logger?.warn({ driver: this.store.driver, error, attempts: this.failures }, 'audit shipping failed; the outbox keeps the events and shipping retries');
    return error;
  }
}

export interface ReconcileResult {
  checked: number;
  verified: number;
  missing: number;
}

/**
 * audit-reconcile: shipped-but-unverified rows older than 30 s are looked up
 * in the store. Held → `verified_at` (only verified rows may ever be pruned
 * locally). Missing → `shipped_at` cleared so the shipper sends them again,
 * and a RECONCILE_MISSING incident. A clean pass resolves that incident; a
 * store that answered resolves STORE_DOWN.
 */
export async function reconcileAudit(db: Db, store: AuditStore, options: { batch?: number; maxRounds?: number; graceSeconds?: number } = {}): Promise<ReconcileResult> {
  const batch = options.batch ?? 1000;
  const result: ReconcileResult = { checked: 0, verified: 0, missing: 0 };
  const missingIds: string[] = [];
  for (let round = 0; round < (options.maxRounds ?? 10); round++) {
    const cutoff = new Date(Date.now() - (options.graceSeconds ?? 30) * 1000);
    const rows = await db
      .select({ id: auditEvents.id })
      .from(auditEvents)
      .where(and(isNotNull(auditEvents.shippedAt), isNull(auditEvents.verifiedAt), lt(auditEvents.shippedAt, cutoff)))
      .orderBy(asc(auditEvents.shippedAt))
      .limit(batch);
    if (!rows.length) break;
    const ids = rows.map((r) => r.id);
    let held: ReadonlySet<string>;
    try {
      held = await store.has(ids);
    } catch (err) {
      await recordAuditIncident(db, 'STORE_DOWN', { driver: store.driver, error: storeError(err), during: 'reconcile' });
      throw err;
    }
    const verified = ids.filter((id) => held.has(id));
    const missing = ids.filter((id) => !held.has(id));
    if (verified.length) await db.update(auditEvents).set({ verifiedAt: new Date() }).where(and(inArray(auditEvents.id, verified), isNull(auditEvents.verifiedAt)));
    if (missing.length) await db.update(auditEvents).set({ shippedAt: null }).where(and(inArray(auditEvents.id, missing), isNull(auditEvents.verifiedAt)));
    result.checked += ids.length;
    result.verified += verified.length;
    result.missing += missing.length;
    missingIds.push(...missing);
    if (rows.length < batch) break;
  }
  if (result.checked) await resolveAuditIncidents(db, ['STORE_DOWN']);
  if (result.missing) await recordAuditIncident(db, 'RECONCILE_MISSING', { driver: store.driver, missing: result.missing, sample: missingIds.slice(0, 5) });
  else if (result.checked) await resolveAuditIncidents(db, ['RECONCILE_MISSING']);
  return result;
}
