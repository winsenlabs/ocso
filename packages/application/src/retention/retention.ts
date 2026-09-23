import { and, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import type { AuditStore } from '@ocso/audit-store';
import { auditEvents, type Db } from '@ocso/db';
import { recordAudit } from '../audit/audit.js';
import { SettingsService } from '../settings/settings.js';
import { systemActor } from '../shared/context.js';
import { purgeConversationContent } from './conversation-content.js';
import { effectiveRetention, type RetentionClass } from './policy.js';

const MEDIA_BATCH = 500;
const ROW_BATCH = 5_000;
/** Bounded work per run; the scheduler runs again on the next interval. */
const MAX_ROUNDS = 10;

export type RetentionReport = Record<RetentionClass, number>;

/** The only BlobStore capability retention needs. */
export interface BlobDeleter {
  delete(key: string): Promise<void>;
}

const daysAgo = (now: Date, days: number) => new Date(now.getTime() - days * 24 * 3600 * 1000);

/**
 * Applies the deployment's retention policy (docs/15 §8). Idempotent and
 * batch-bounded; safe to run on any schedule. Blob deletes happen after the
 * owning rows are updated so a failed delete never loses the reference.
 *
 * Audit (ADR-032): with an audit store, the audit trail's retention applies to
 * the store (`purgeBefore`, never younger than 365 days), and the main
 * database keeps only a local window (`audit_local_window_days`) of rows the
 * store has verified. Without one (tools, tests) the old in-place rule applies.
 */
export class RetentionService {
  constructor(
    private readonly db: Db,
    private readonly blobs: BlobDeleter,
    private readonly log: (msg: string, err?: unknown) => void = () => {},
    private readonly auditStore: AuditStore | null = null,
  ) {}

  async run(now: Date = new Date()): Promise<RetentionReport> {
    const deployment = await new SettingsService(this.db).deployment();
    const days = effectiveRetention(deployment.retention);
    const report: RetentionReport = { conversationContent: 0, media: 0, toolPayloads: 0, internalAgent: 0, usage: 0, operational: 0, auditEvents: 0 };

    for (let i = 0; i < MAX_ROUNDS; i++) {
      const { conversations, blobKeys } = await purgeConversationContent(this.db, daysAgo(now, days.conversationContent));
      await this.deleteBlobs(blobKeys);
      report.conversationContent += conversations;
      if (!conversations) break;
    }
    report.media = await this.expireMedia(daysAgo(now, days.media));
    report.toolPayloads = await this.rounds(sql`
      UPDATE tool_calls SET args_sanitized = '{}'::jsonb, result_summary = NULL, error_message = NULL
       WHERE id IN (SELECT id FROM tool_calls WHERE requested_at < ${daysAgo(now, days.toolPayloads)} AND status <> 'AWAITING_CONFIRMATION'
                      AND (args_sanitized <> '{}'::jsonb OR result_summary IS NOT NULL) LIMIT ${ROW_BATCH})`);
    const agentCutoff = daysAgo(now, days.internalAgent);
    report.internalAgent =
      (await this.rounds(sql`DELETE FROM internal_agent_messages WHERE id IN (SELECT id FROM internal_agent_messages WHERE created_at < ${agentCutoff} LIMIT ${ROW_BATCH})`)) +
      (await this.rounds(sql`DELETE FROM internal_agent_actions WHERE id IN (SELECT id FROM internal_agent_actions WHERE created_at < ${agentCutoff} AND status <> 'PENDING' LIMIT ${ROW_BATCH})`));
    await this.db.execute(sql`DELETE FROM internal_agent_threads t WHERE t.updated_at < ${agentCutoff}
      AND NOT EXISTS (SELECT 1 FROM internal_agent_messages m WHERE m.thread_id = t.id)
      AND NOT EXISTS (SELECT 1 FROM internal_agent_actions a WHERE a.thread_id = t.id)`);
    report.usage = await this.rounds(sql`DELETE FROM usage_events WHERE id IN (SELECT id FROM usage_events WHERE occurred_at < ${daysAgo(now, days.usage)} LIMIT ${ROW_BATCH})`);
    report.operational = await this.operational(daysAgo(now, days.operational));
    let localPruned = 0;
    if (this.auditStore) {
      localPruned = await this.pruneLocalAudit(daysAgo(now, Math.max(90, deployment.auditLocalWindowDays)));
      report.auditEvents = await this.purgeAuditStore(daysAgo(now, days.auditEvents));
    } else {
      report.auditEvents = await this.audit(daysAgo(now, days.auditEvents));
    }

    if (Object.values(report).some((n) => n > 0) || localPruned > 0) {
      await this.db.transaction((tx) =>
        recordAudit(tx, systemActor('retention', `retention:${now.toISOString()}`, 'Retention policy'), {
          action: 'retention.applied',
          targetType: 'deployment',
          summary: `Retention applied: ${[...Object.entries(report), ['auditLocalWindow', localPruned] as const].filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`).join(', ')}`,
          after: { report, days, ...(this.auditStore ? { auditLocalPruned: localPruned, auditLocalWindowDays: deployment.auditLocalWindowDays } : {}) },
        }),
      );
    }
    return report;
  }

  private async expireMedia(cutoff: Date): Promise<number> {
    let total = 0;
    for (let i = 0; i < MAX_ROUNDS; i++) {
      const { rows } = await this.db.execute<{ id: string; blob_key: string }>(sql`
        SELECT p.id, p.blob_key FROM interaction_parts p JOIN interactions i ON i.id = p.interaction_id
         WHERE p.blob_key IS NOT NULL AND i.created_at < ${cutoff} LIMIT ${MEDIA_BATCH}`);
      if (!rows.length) break;
      const deleted: string[] = [];
      for (const row of rows) {
        try {
          await this.blobs.delete(row.blob_key);
          deleted.push(row.id);
        } catch (err) {
          this.log('retention: blob delete failed; will retry next run', err);
        }
      }
      if (deleted.length) {
        await this.db.execute(sql`
          UPDATE interaction_parts SET blob_key = NULL, media_status = 'EXPIRED',
                 content = jsonb_set(content #- '{media,blobKey}', '{media,status}', '"EXPIRED"')
           WHERE id = ANY(ARRAY[${sql.join(deleted.map((id) => sql`${id}::uuid`), sql`, `)}])`);
      }
      total += deleted.length;
      if (deleted.length < rows.length) break;
    }
    return total;
  }

  private async operational(cutoff: Date): Promise<number> {
    const statements = [
      sql`DELETE FROM outbox_events WHERE id IN (SELECT id FROM outbox_events WHERE published_at IS NOT NULL AND published_at < ${cutoff} LIMIT ${ROW_BATCH})`,
      sql`DELETE FROM health_samples WHERE id IN (SELECT id FROM health_samples WHERE sampled_at < ${cutoff} LIMIT ${ROW_BATCH})`,
      sql`DELETE FROM mcp_health_samples WHERE id IN (SELECT id FROM mcp_health_samples WHERE sampled_at < ${cutoff} LIMIT ${ROW_BATCH})`,
      sql`DELETE FROM webhook_deliveries WHERE id IN (SELECT id FROM webhook_deliveries WHERE status <> 'PENDING' AND created_at < ${cutoff} LIMIT ${ROW_BATCH})`,
      sql`DELETE FROM login_attempts WHERE id IN (SELECT id FROM login_attempts WHERE occurred_at < ${cutoff} LIMIT ${ROW_BATCH})`,
      sql`DELETE FROM auth_sessions WHERE id IN (SELECT id FROM auth_sessions WHERE expires_at < ${cutoff} LIMIT ${ROW_BATCH})`,
      sql`DELETE FROM auth_verifications WHERE id IN (SELECT id FROM auth_verifications WHERE expires_at < ${cutoff} LIMIT ${ROW_BATCH})`,
      sql`DELETE FROM jobs WHERE id IN (SELECT id FROM jobs WHERE status = 'dead' AND completed_at < ${cutoff} LIMIT ${ROW_BATCH})`,
      sql`DELETE FROM scheduled_jobs WHERE id IN (SELECT id FROM scheduled_jobs WHERE dispatched_at < ${cutoff} LIMIT ${ROW_BATCH})`,
    ];
    let total = 0;
    for (const statement of statements) total += await this.rounds(statement);
    return total;
  }

  /** Audit rows are append-only; the DB trigger permits deleting only rows older than a cutoff ≥ 365 days. */
  private async audit(cutoff: Date): Promise<number> {
    let total = 0;
    for (let i = 0; i < MAX_ROUNDS; i++) {
      const n = await this.db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('ocso.audit_retention_cutoff', ${cutoff.toISOString()}, true)`);
        const { rowCount } = await tx.execute(sql`DELETE FROM audit_events WHERE id IN (SELECT id FROM audit_events WHERE occurred_at < ${cutoff} LIMIT ${ROW_BATCH})`);
        return rowCount ?? 0;
      });
      total += n;
      if (n < ROW_BATCH) break;
    }
    return total;
  }

  /**
   * Local window prune: rows the store verified and older than the window. The
   * trigger allows it only under ocso.audit_local_prune, for verified rows older
   * than 90 days — an unshipped or unverified row is never deleted here. Each
   * batch is checked against the store once more first (a store restored from
   * a backup no longer holds what it verified): rows it no longer holds get
   * shipped_at/verified_at cleared and are shipped again instead of deleted.
   * Rows older than the store's purge horizon are gone from the store by
   * retention and are pruned as before. A store that fails stops the prune.
   */
  private async pruneLocalAudit(cutoff: Date): Promise<number> {
    const store = this.auditStore!;
    let horizon: Date | null;
    try {
      horizon = await store.purgeHorizon();
    } catch (err) {
      this.log('retention: audit store unavailable; local audit window not pruned this run', err);
      return 0;
    }
    let total = 0;
    for (let i = 0; i < MAX_ROUNDS; i++) {
      const rows = await this.db
        .select({ id: auditEvents.id, occurredAt: auditEvents.occurredAt })
        .from(auditEvents)
        .where(and(isNotNull(auditEvents.verifiedAt), lt(auditEvents.occurredAt, cutoff)))
        .limit(ROW_BATCH);
      if (!rows.length) break;
      const check = rows.filter((r) => !horizon || r.occurredAt >= horizon).map((r) => r.id);
      let held: ReadonlySet<string>;
      try {
        held = await store.has(check);
      } catch (err) {
        this.log('retention: audit store unavailable; local audit window prune stopped', err);
        break;
      }
      const lost = check.filter((id) => !held.has(id));
      const prunable = rows.map((r) => r.id).filter((id) => !lost.includes(id));
      if (lost.length) {
        await this.db.update(auditEvents).set({ shippedAt: null, verifiedAt: null }).where(inArray(auditEvents.id, lost));
        this.log(`retention: the audit store no longer holds ${lost.length} verified audit events (restored from a backup?); they will be shipped again`);
      }
      const n = prunable.length
        ? await this.db.transaction(async (tx) => {
            await tx.execute(sql`SELECT set_config('ocso.audit_local_prune', 'on', true)`);
            const deleted = await tx.delete(auditEvents).where(and(inArray(auditEvents.id, prunable), isNotNull(auditEvents.verifiedAt))).returning({ id: auditEvents.id });
            return deleted.length;
          })
        : 0;
      total += n;
      if (rows.length < ROW_BATCH) break;
    }
    return total;
  }

  /** The store drops whole months older than the cutoff (and refuses anything younger than 365 days). */
  private async purgeAuditStore(cutoff: Date): Promise<number> {
    try {
      return await this.auditStore!.purgeBefore(cutoff);
    } catch (err) {
      this.log('retention: audit store purge failed; will retry next run', err);
      return 0;
    }
  }

  private async rounds(statement: ReturnType<typeof sql>): Promise<number> {
    let total = 0;
    for (let i = 0; i < MAX_ROUNDS; i++) {
      const { rowCount } = await this.db.execute(statement);
      total += rowCount ?? 0;
      if ((rowCount ?? 0) < ROW_BATCH) break;
    }
    return total;
  }

  private async deleteBlobs(keys: readonly string[]): Promise<void> {
    for (const key of keys) await this.blobs.delete(key).catch((err: unknown) => this.log('retention: blob delete failed (orphaned object)', err));
  }
}
