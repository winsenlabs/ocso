import pg from 'pg';
import { assertContinues } from '../chain.js';
import {
  AUDIT_STORE_CONNECT_TIMEOUT_MS,
  AUDIT_STORE_TIMEOUT_MS,
  flooredCutoff,
  purgeHorizonOf,
  withTimeout,
  type AuditPurge,
  type AuditRecord,
  type AuditScopeFilter,
  type AuditStore,
  type AuditStoreHealth,
  type AuditStoreQuery,
  type AuditStoreSelfCheck,
  type AuditStoreStats,
  type ChainEntry,
  type ChainRangeItem,
  type Checkpoint,
  type CheckpointQuery,
} from '../contract.js';
import { RECORD_COLUMNS, RECORDSET, recordFilter, toChainEntry, toCheckpoint, toRecord, toRecordJson, type ChainRow, type CheckpointRow, type RecordRow } from './sql.js';

export interface PostgresAuditStoreOptions {
  connectionString: string;
  poolSize?: number | undefined;
  ssl?: boolean | undefined;
  applicationName?: string | undefined;
  onError?: ((err: Error) => void) | undefined;
  /** Bound on each statement, client and server side (default AUDIT_STORE_TIMEOUT_MS). */
  timeoutMs?: number | undefined;
}

/** A purge drops whole partitions; it may take longer than an ordinary statement. */
const PURGE_TIMEOUT_MS = 10 * 60 * 1000;

/** Records that may still commit after later ones (concurrent appends) are looked for this far behind the sealed watermark. */
const UNSEALED_LOOKBACK = 10_000;
const CHAIN_LOCK = "hashtext('ocso_audit_chain')";
const NO_PARTITION = '23514';
const monthKey = (d: Date) => d.getUTCFullYear() * 100 + d.getUTCMonth() + 1;

/**
 * The postgres audit store (PM/research/11 §6.5): its own database, reached as
 * the writer role (INSERT/SELECT only). Monthly partitions are created ahead by
 * audit_ensure_partitions; this driver also ensures the month of anything older
 * it is asked to append (the outbox backfill ships old rows).
 */
export class PostgresAuditStore implements AuditStore {
  readonly driver = 'postgres';
  readonly sizing = { kind: 'row', label: 'PostgreSQL' } as const;
  private readonly pool: pg.Pool;
  /** Months (yyyymm) whose partitions this process has ensured, and when the forward window was last ensured. */
  private readonly ensured = new Set<number>();
  private forwardEnsuredAt = 0;
  private readonly timeoutMs: number;

  constructor(options: PostgresAuditStoreOptions) {
    this.timeoutMs = options.timeoutMs ?? AUDIT_STORE_TIMEOUT_MS;
    // Never wait forever on a store that stops answering (blackholed network, failover):
    // bounded connect, client-side query timeout and the same bound server side.
    this.pool = new pg.Pool({
      connectionString: options.connectionString,
      max: options.poolSize ?? 5,
      application_name: options.applicationName ?? 'ocso-audit',
      ssl: options.ssl ? { rejectUnauthorized: true } : undefined,
      connectionTimeoutMillis: Math.min(AUDIT_STORE_CONNECT_TIMEOUT_MS, this.timeoutMs),
      query_timeout: this.timeoutMs,
      statement_timeout: this.timeoutMs,
      idle_in_transaction_session_timeout: this.timeoutMs * 2,
      keepAlive: true,
    });
    this.pool.on('error', (err) => options.onError?.(err));
  }

  async append(records: readonly AuditRecord[]): Promise<void> {
    if (!records.length) return;
    await this.ensurePartitions(records);
    const insert = () =>
      this.pool.query(
        `INSERT INTO audit_records (${RECORD_COLUMNS}) SELECT ${RECORD_COLUMNS} FROM jsonb_to_recordset($1::jsonb) AS ${RECORDSET}
         ON CONFLICT (id, occurred_at) DO NOTHING`,
        [JSON.stringify(records.map(toRecordJson))],
      );
    try {
      await insert();
    } catch (err) {
      if ((err as { code?: string }).code !== NO_PARTITION) throw err;
      // A month this process thought was covered (e.g. purged meanwhile): ensure it and retry once.
      this.ensured.clear();
      this.forwardEnsuredAt = 0;
      await this.ensurePartitions(records);
      await insert();
    }
  }

  async has(ids: readonly string[]): Promise<ReadonlySet<string>> {
    if (!ids.length) return new Set();
    const { rows } = await this.pool.query<{ id: string }>('SELECT id FROM audit_records WHERE id = ANY($1::uuid[])', [[...ids]]);
    return new Set(rows.map((r) => r.id));
  }

  async query(q: AuditStoreQuery, scope: AuditScopeFilter): Promise<AuditRecord[]> {
    const { where, params } = recordFilter(q, scope);
    params.push(q.limit);
    const { rows } = await this.pool.query<RecordRow>(`SELECT ${RECORD_COLUMNS} FROM audit_records r ${where} ORDER BY r.occurred_at DESC, r.id DESC LIMIT $${params.length}`, params);
    return rows.map(toRecord);
  }

  async unsealed(limit: number): Promise<AuditRecord[]> {
    const { rows } = await this.pool.query<RecordRow>(
      `WITH head AS (SELECT coalesce(max(position), 0) AS p FROM audit_chain),
            mark AS (SELECT coalesce(max(r.ingest_seq), 0) AS s FROM audit_chain c
                       JOIN audit_records r ON r.id = c.record_id AND r.occurred_at = c.record_occurred_at
                      WHERE c.position > (SELECT p FROM head) - 100)
       SELECT ${RECORD_COLUMNS.split(', ').map((c) => `r.${c}`).join(', ')} FROM audit_records r
        WHERE r.ingest_seq > (SELECT s FROM mark) - ${UNSEALED_LOOKBACK}
          AND NOT EXISTS (SELECT 1 FROM audit_chain c WHERE c.record_id = r.id)
        ORDER BY r.ingest_seq LIMIT $1`,
      [limit],
    );
    return rows.map(toRecord);
  }

  async chainHead(): Promise<ChainEntry | null> {
    const { rows } = await this.pool.query<ChainRow>('SELECT * FROM audit_chain ORDER BY position DESC LIMIT 1');
    return rows[0] ? toChainEntry(rows[0]) : null;
  }

  async appendChain(entries: readonly ChainEntry[]): Promise<void> {
    if (!entries.length) return;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT pg_advisory_xact_lock(${CHAIN_LOCK})`);
      const { rows } = await client.query<ChainRow>('SELECT * FROM audit_chain ORDER BY position DESC LIMIT 1');
      assertContinues(rows[0] ? toChainEntry(rows[0]) : null, entries);
      await client.query(
        `INSERT INTO audit_chain (position, record_id, record_occurred_at, record_hash, prev_hash, chain_hash, sealed_at)
         SELECT position, record_id, record_occurred_at, record_hash, prev_hash, chain_hash, sealed_at
           FROM jsonb_to_recordset($1::jsonb) AS x(position bigint, record_id uuid, record_occurred_at timestamptz, record_hash text, prev_hash text, chain_hash text, sealed_at timestamptz)`,
        [JSON.stringify(entries.map((e) => ({ position: e.position, record_id: e.recordId, record_occurred_at: e.recordOccurredAt.toISOString(), record_hash: e.recordHash, prev_hash: e.prevHash, chain_hash: e.chainHash, sealed_at: e.sealedAt.toISOString() })))],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async appendCheckpoint(c: Checkpoint): Promise<void> {
    await this.pool.query(
      'INSERT INTO audit_checkpoints (id, up_to_position, chain_hash, created_at, key_id, signature) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING',
      [c.id, c.upToPosition, c.chainHash, c.createdAt, c.keyId, c.signature],
    );
  }

  async checkpoints(q: CheckpointQuery): Promise<Checkpoint[]> {
    const params: unknown[] = [];
    const clauses: string[] = [];
    if (q.since) clauses.push(`created_at >= $${params.push(q.since)}`);
    if (q.fromPosition !== undefined) clauses.push(`up_to_position >= $${params.push(q.fromPosition)}`);
    if (q.toPosition !== undefined) clauses.push(`up_to_position <= $${params.push(q.toPosition)}`);
    params.push(q.limit);
    const { rows } = await this.pool.query<CheckpointRow>(
      `SELECT * FROM audit_checkpoints ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY up_to_position DESC, created_at DESC LIMIT $${params.length}`,
      params,
    );
    return rows.map(toCheckpoint);
  }

  async chainRange(fromPosition: number, limit: number): Promise<ChainRangeItem[]> {
    // `conflicts`: another copy of the record under the same id (the key includes occurred_at, so a
    // second insert with another time is possible for anyone holding INSERT); verify reports it.
    const { rows } = await this.pool.query<ChainRow & Partial<RecordRow> & { r_id: string | null; conflicts: string }>(
      `SELECT c.position, c.record_id, c.record_occurred_at, c.record_hash, c.prev_hash, c.chain_hash, c.sealed_at,
              r.id AS r_id, r.occurred_at, r.actor_type, r.actor_id, r.actor_name, r.via, r.action, r.target_type, r.target_id,
              r.summary, r.before, r.after, r.correlation_id, r.confirmation, r.ip, r.team_ids,
              (SELECT count(*) FROM audit_records r2 WHERE r2.id = c.record_id AND r2.occurred_at <> c.record_occurred_at) AS conflicts
         FROM audit_chain c
         LEFT JOIN audit_records r ON r.id = c.record_id AND r.occurred_at = c.record_occurred_at
        WHERE c.position >= $1 ORDER BY c.position LIMIT $2`,
      [fromPosition, limit],
    );
    return rows.map((row) => ({
      entry: toChainEntry(row),
      record: row.r_id ? toRecord({ ...(row as unknown as RecordRow), id: row.r_id }) : null,
      ...(Number(row.conflicts) ? { conflicts: Number(row.conflicts) } : {}),
    }));
  }

  async purgeBefore(cutoff: Date): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL statement_timeout = ${PURGE_TIMEOUT_MS}`);
      const { rows } = await client.query<{ removed: string }>({ text: 'SELECT audit_purge_before($1) AS removed', values: [flooredCutoff(cutoff)], query_timeout: PURGE_TIMEOUT_MS } as pg.QueryConfig);
      await client.query('COMMIT');
      this.ensured.clear();
      return Number(rows[0]?.removed ?? 0);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async purges(): Promise<AuditPurge[]> {
    const { rows } = await this.pool.query<{ purged_at: Date; cutoff: Date; partitions: string[] }>('SELECT purged_at, cutoff, partitions FROM audit_purges ORDER BY purged_at, id');
    return rows.map((r) => ({
      purgedAt: r.purged_at,
      cutoff: r.cutoff,
      // audit_purge_before logs the dropped partition names (audit_records_pYYYYMM).
      months: r.partitions.map((name) => /^audit_records_p(\d{6})$/.exec(name)?.[1]).filter((m): m is string => m !== undefined).map(Number),
    }));
  }

  async purgeHorizon(): Promise<Date | null> {
    return purgeHorizonOf(await this.purges());
  }

  async selfCheck(): Promise<AuditStoreSelfCheck> {
    const { rows } = await this.pool.query<{ superuser: boolean; owner: boolean; can_insert: boolean; can_mutate: boolean; can_purge: boolean }>(
      `SELECT coalesce((SELECT rolsuper FROM pg_roles WHERE rolname = current_user), false) AS superuser,
              pg_has_role(current_user, c.relowner, 'USAGE') AS owner,
              has_table_privilege('audit_records', 'INSERT') AS can_insert,
              has_table_privilege('audit_records', 'UPDATE') OR has_table_privilege('audit_records', 'DELETE') OR has_table_privilege('audit_records', 'TRUNCATE') AS can_mutate,
              has_function_privilege('audit_purge_before(timestamptz)', 'EXECUTE') AS can_purge
         FROM pg_class c WHERE c.oid = 'audit_records'::regclass`,
    );
    const r = rows[0];
    const warnings: string[] = [];
    if (r?.superuser || r?.owner) warnings.push('connected as a superuser or the owner of the audit tables: it can disable the append-only triggers (use the writer/reader roles audit-migrate provisions)');
    else if (r?.can_mutate) warnings.push('these credentials hold UPDATE, DELETE or TRUNCATE on audit_records (the triggers still refuse them)');
    return { canWrite: Boolean(r?.can_insert || r?.can_purge), warnings };
  }

  async stats(): Promise<AuditStoreStats> {
    const { rows } = await this.pool.query<{ estimate: string | null; unknown: boolean; bytes: string | null }>(
      `SELECT sum(GREATEST(c.reltuples, 0))::bigint AS estimate, bool_or(c.reltuples < 0) AS unknown, sum(pg_total_relation_size(c.oid))::bigint AS bytes
         FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid WHERE i.inhparent = 'audit_records'::regclass`,
    );
    const stat = rows[0];
    let count = Number(stat?.estimate ?? 0);
    if (stat?.unknown || count < 100_000) count = Number((await this.pool.query<{ n: string }>('SELECT count(*) AS n FROM audit_records')).rows[0]?.n ?? 0);
    const range = (await this.pool.query<{ oldest: Date | null; newest: Date | null }>('SELECT min(occurred_at) AS oldest, max(occurred_at) AS newest FROM audit_records')).rows[0];
    return { rows: count, bytes: stat?.bytes === null || stat?.bytes === undefined ? null : Number(stat.bytes), oldest: range?.oldest ?? null, newest: range?.newest ?? null };
  }

  async health(): Promise<AuditStoreHealth> {
    const started = performance.now();
    try {
      await withTimeout(this.pool.query('SELECT 1'), Math.min(AUDIT_STORE_CONNECT_TIMEOUT_MS, this.timeoutMs), 'the audit store');
      return { ok: true, latencyMs: Math.round(performance.now() - started) };
    } catch (err) {
      return { ok: false, latencyMs: Math.round(performance.now() - started), detail: (err as { code?: string }).code ?? 'unreachable' };
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  /** Partitions for every month in the batch (and the months ahead, daily). */
  private async ensurePartitions(records: readonly AuditRecord[]): Promise<void> {
    const now = Date.now();
    if (now - this.forwardEnsuredAt > 24 * 3600 * 1000) {
      await this.pool.query('SELECT audit_ensure_partitions(2)');
      this.forwardEnsuredAt = now;
      const d = new Date();
      for (let i = 0; i <= 2; i++) this.ensured.add(monthKey(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + i, 1))));
    }
    const missing = records.filter((r) => !this.ensured.has(monthKey(r.occurredAt)));
    if (!missing.length) return;
    const oldest = missing.reduce((min, r) => (r.occurredAt < min ? r.occurredAt : min), missing[0]!.occurredAt);
    await this.pool.query('SELECT audit_ensure_partitions(2, $1)', [oldest]);
    for (let d = new Date(Date.UTC(oldest.getUTCFullYear(), oldest.getUTCMonth(), 1)); d.getTime() <= now; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) {
      this.ensured.add(monthKey(d));
    }
  }
}
