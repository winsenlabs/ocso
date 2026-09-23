import { sql } from 'drizzle-orm';
import { PostgresAuditStore, type AuditRecord, type AuditStore } from '@ocso/audit-store';
import type { Db } from '@ocso/db';

/**
 * A real postgres audit store with switches for failure paths: `down` makes
 * every call fail like an unreachable store, `hang` makes query/append never
 * answer (a blackholed network), `drop` silently loses the appended records
 * whose ids it holds (what reconciliation exists to catch).
 */
export class FlakyStore implements AuditStore {
  readonly driver = 'flaky';
  down = false;
  hang = false;
  readonly drop = new Set<string>();
  appends = 0;

  constructor(readonly inner: PostgresAuditStore) {}

  private check(): void {
    if (this.down) throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5439'), { code: 'ECONNREFUSED' });
  }
  private async stall(): Promise<void> {
    if (this.hang) await new Promise(() => {});
  }

  async append(records: readonly AuditRecord[]) {
    this.check();
    await this.stall();
    this.appends++;
    await this.inner.append(records.filter((r) => !this.drop.has(r.id)));
  }
  async has(ids: readonly string[]) {
    this.check();
    return this.inner.has(ids);
  }
  async query(...args: Parameters<AuditStore['query']>) {
    this.check();
    await this.stall();
    return this.inner.query(...args);
  }
  async unsealed(limit: number) {
    this.check();
    return this.inner.unsealed(limit);
  }
  async chainHead() {
    this.check();
    return this.inner.chainHead();
  }
  async appendChain(...args: Parameters<AuditStore['appendChain']>) {
    this.check();
    return this.inner.appendChain(...args);
  }
  async appendCheckpoint(...args: Parameters<AuditStore['appendCheckpoint']>) {
    this.check();
    return this.inner.appendCheckpoint(...args);
  }
  async checkpoints(...args: Parameters<AuditStore['checkpoints']>) {
    this.check();
    return this.inner.checkpoints(...args);
  }
  async chainRange(...args: Parameters<AuditStore['chainRange']>) {
    this.check();
    return this.inner.chainRange(...args);
  }
  async purgeBefore(cutoff: Date) {
    this.check();
    return this.inner.purgeBefore(cutoff);
  }
  async purgeHorizon() {
    this.check();
    return this.inner.purgeHorizon();
  }
  async selfCheck() {
    this.check();
    return this.inner.selfCheck();
  }
  async stats() {
    this.check();
    return this.inner.stats();
  }
  async health() {
    return this.down ? { ok: false, latencyMs: 1, detail: 'ECONNREFUSED' } : this.inner.health();
  }
  async close() {
    await this.inner.close();
  }
}

/** Moves audit rows back in time (the trigger rightly refuses; tests turn it off for one statement). */
export async function backdateAudit(db: Db, ids: readonly string[], days: number): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`ALTER TABLE audit_events DISABLE TRIGGER audit_events_immutable`);
    await tx.execute(sql`UPDATE audit_events SET occurred_at = now() - make_interval(days => ${days}) WHERE id = ANY(${sql.raw(`ARRAY[${ids.map((id) => `'${id}'::uuid`).join(',')}]`)})`);
    await tx.execute(sql`ALTER TABLE audit_events ENABLE TRIGGER audit_events_immutable`);
  });
}

/** Postgres error text through drizzle's wrapping. */
export async function failure(p: Promise<unknown>): Promise<string> {
  const err = await p.then(() => null, (e: unknown) => e);
  const messages: string[] = [];
  let cursor: unknown = err;
  while (cursor instanceof Error) {
    messages.push(cursor.message);
    cursor = (cursor as Error & { cause?: unknown }).cause;
  }
  return messages.join(' | ') || 'no error';
}
