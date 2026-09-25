import { and, eq, inArray, sql } from 'drizzle-orm';
import { DomainError } from '@ocso/domain';
import { conversationLeases, type DbOrTx } from '@ocso/db';

export interface LeaseTiming {
  /** Lease validity while a turn runs; extended by heartbeats. */
  leaseSeconds: number;
  /** How long an idle (warm) lease keeps affinity after a turn. */
  idleSeconds: number;
}

export type AcquireOutcome =
  | { kind: 'acquired'; leaseVersion: number; warm: boolean }
  | { kind: 'busy_elsewhere'; workerId: string };

export class LeaseLostError extends DomainError {
  constructor(conversationId: string) {
    super('conflict', 'lease_lost', `lease for conversation ${conversationId} is no longer held by this worker`);
  }
}

/**
 * Conversation leases (docs/archive/specs/10 §2, ADR-008). A lease is the only permission to
 * run a turn; `lease_version` is a fencing token checked in every
 * customer-visible write.
 */
export class LeaseManager {
  constructor(
    private readonly db: DbOrTx,
    readonly workerId: string,
    private timing: LeaseTiming,
  ) {}

  setTiming(timing: LeaseTiming): void {
    this.timing = timing;
  }

  /**
   * Take (or renew) the lease and mark it busy. Succeeds when the lease is ours,
   * expired, or idle on another worker (transfer); fails when another live
   * worker is mid-turn.
   */
  async acquire(conversationId: string): Promise<AcquireOutcome> {
    const { rows } = await this.db.execute<{ lease_version: string; warm: boolean }>(sql`
      INSERT INTO conversation_leases AS l (conversation_id, worker_id, lease_version, busy, acquired_at, heartbeat_at, expires_at)
      VALUES (${conversationId}, ${this.workerId}, 1, true, now(), now(), now() + make_interval(secs => ${this.timing.leaseSeconds}))
      ON CONFLICT (conversation_id) DO UPDATE SET
        worker_id = ${this.workerId},
        lease_version = l.lease_version + 1,
        busy = true,
        acquired_at = CASE WHEN l.worker_id = ${this.workerId} THEN l.acquired_at ELSE now() END,
        heartbeat_at = now(),
        expires_at = now() + make_interval(secs => ${this.timing.leaseSeconds})
      WHERE l.worker_id = ${this.workerId} OR l.expires_at < now() OR NOT l.busy
      RETURNING lease_version, (xmax <> 0 AND l.worker_id = ${this.workerId}) AS warm`);
    const row = rows[0];
    if (row) return { kind: 'acquired', leaseVersion: Number(row.lease_version), warm: Boolean(row.warm) };
    const holder = await this.db.execute<{ worker_id: string }>(
      sql`SELECT worker_id FROM conversation_leases WHERE conversation_id = ${conversationId}`,
    );
    return { kind: 'busy_elsewhere', workerId: holder.rows[0]?.worker_id ?? 'unknown' };
  }

  /**
   * Drain-then-idle (ADR-008 step 2): mark the lease idle only if no customer
   * message is still unanswered while AI owns the conversation. Returns false
   * when new work arrived, in which case the caller must loop.
   */
  async markIdle(conversationId: string, leaseVersion: number): Promise<boolean> {
    const { rows } = await this.db.execute<{ conversation_id: string }>(sql`
      UPDATE conversation_leases SET busy = false, heartbeat_at = now(),
             expires_at = now() + make_interval(secs => ${this.timing.idleSeconds})
       WHERE conversation_id = ${conversationId} AND worker_id = ${this.workerId} AND lease_version = ${leaseVersion}
         AND NOT EXISTS (
           SELECT 1 FROM interactions i JOIN conversations c ON c.id = i.conversation_id
            WHERE i.conversation_id = ${conversationId} AND i.actor_type = 'CUSTOMER' AND i.kind = 'MESSAGE'
              AND i.seq > c.last_processed_seq AND c.control_state IN ('AI_ACTIVE', 'AI_RESUMING'))
       RETURNING conversation_id`);
    return rows.length > 0;
  }

  /** Extend busy leases held by this worker; returns conversations whose lease was lost. */
  async heartbeat(conversationIds: readonly string[]): Promise<string[]> {
    if (!conversationIds.length) return [];
    const rows = await this.db
      .update(conversationLeases)
      .set({ heartbeatAt: sql`now()`, expiresAt: sql`now() + make_interval(secs => ${this.timing.leaseSeconds})` })
      .where(and(eq(conversationLeases.workerId, this.workerId), eq(conversationLeases.busy, true), inArray(conversationLeases.conversationId, [...conversationIds])))
      .returning({ conversationId: conversationLeases.conversationId });
    const kept = new Set(rows.map((r) => r.conversationId));
    return conversationIds.filter((id) => !kept.has(id));
  }

  /** Fencing check inside a write transaction (FOR SHARE blocks a concurrent transfer). */
  async assertHeld(tx: DbOrTx, conversationId: string, leaseVersion: number): Promise<void> {
    const { rows } = await tx.execute(sql`
      SELECT 1 FROM conversation_leases
       WHERE conversation_id = ${conversationId} AND worker_id = ${this.workerId} AND lease_version = ${leaseVersion}
       FOR SHARE`);
    if (!rows.length) throw new LeaseLostError(conversationId);
  }

  async release(conversationId: string): Promise<void> {
    await this.db.execute(sql`DELETE FROM conversation_leases WHERE conversation_id = ${conversationId} AND worker_id = ${this.workerId}`);
  }

  /** Leases held by this worker (busy or warm) — slot accounting for capacity. */
  async held(): Promise<number> {
    const { rows } = await this.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM conversation_leases WHERE worker_id = ${this.workerId} AND expires_at > now()`,
    );
    return rows[0]?.n ?? 0;
  }

  /** Drop all leases on graceful shutdown so other workers take over immediately. */
  async releaseAll(): Promise<void> {
    await this.db.execute(sql`DELETE FROM conversation_leases WHERE worker_id = ${this.workerId} AND NOT busy`);
  }
}
