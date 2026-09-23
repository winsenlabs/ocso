import { recordHash } from '../canonical.js';
import { assertContinues } from '../chain.js';
import {
  PURGE_FLOOR_DAYS,
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
import { checkGrants } from './grants.js';
import { chDateTime, type ClickHouseHttp, type ClickHouseParam } from './http.js';
import { CHAIN_COLUMNS, COLUMNS, json, toCheckpoint, toEntry, toRecord, utc, type ChainRow, type CheckpointRow, type RecordRow } from './rows.js';

/** First copy per id (earliest ingest) — a later insert of the same id never replaces what was stored. */
const FIRST_COPY = 'LIMIT 1 BY id_s';

/**
 * The clickhouse audit store (PM/research/11 §6.5): MergeTree records read
 * first-copy-wins, MergeTree chain and checkpoints. ClickHouse cannot refuse
 * UPDATE/DELETE by trigger and has no unique keys: the writer user holds
 * SELECT/INSERT only, and anything an INSERT can do to history (a second copy
 * of a record, a second chain row at a position) is reported by verification
 * (RECORD_CONFLICT, CHAIN_FORK) — tamper-evident, not tamper-proof (ADR-032).
 * Dropping a partition needs ALTER DELETE, so the purge runs as a separate
 * purge user (worker only), logs itself in audit_purges and honours the
 * admin-set minimum retention (never below PURGE_FLOOR_DAYS).
 */
export class ClickHouseAuditStore implements AuditStore {
  readonly driver = 'clickhouse';

  constructor(
    private readonly ch: ClickHouseHttp,
    /** The purge user's connection (worker only); null = this process cannot purge. */
    private readonly purge: ClickHouseHttp | null = null,
  ) {}

  async append(records: readonly AuditRecord[]): Promise<void> {
    await this.ch.insert(
      'audit_records',
      records.map((r) => ({
        id: r.id,
        occurred_at: chDateTime(r.occurredAt),
        actor_type: r.actorType,
        actor_id: r.actorId,
        actor_name: r.actorName,
        via: r.via,
        action: r.action,
        target_type: r.targetType,
        target_id: r.targetId,
        summary: r.summary,
        before: json(r.before),
        after: json(r.after),
        correlation_id: r.correlationId,
        confirmation: json(r.confirmation),
        ip: r.ip,
        team_ids: [...r.teamIds],
      })),
    );
  }

  async has(ids: readonly string[]): Promise<ReadonlySet<string>> {
    if (!ids.length) return new Set();
    const rows = await this.ch.query<{ id_s: string }>('SELECT DISTINCT toString(id) AS id_s FROM audit_records WHERE id IN {ids:Array(UUID)}', { ids: [...ids] });
    return new Set(rows.map((r) => r.id_s));
  }

  async query(q: AuditStoreQuery, scope: AuditScopeFilter): Promise<AuditRecord[]> {
    const params: Record<string, ClickHouseParam> = { limit: q.limit };
    const where: string[] = [];
    if (scope) {
      Object.assign(params, { s_actor: scope.actorId, s_teams: [...scope.teamIds], s_shared: [...scope.sharedTargetTypes] });
      where.push('(actor_id = {s_actor:String} OR hasAny(team_ids, {s_teams:Array(UUID)}) OR has({s_shared:Array(String)}, target_type))');
    }
    const eq = (column: string, name: string, value: string | undefined) => {
      if (value === undefined || value === '') return;
      params[name] = value;
      where.push(`${column} = {${name}:String}`);
    };
    eq('target_type', 'target_type', q.targetType);
    eq('target_id', 'target_id', q.targetId);
    eq('actor_id', 'actor_id', q.actorId);
    eq('via', 'via', q.via);
    if (q.targetTypes?.length) {
      params['target_types'] = [...q.targetTypes];
      where.push('has({target_types:Array(String)}, target_type)');
    }
    if (q.actionPrefix) {
      params['action_prefix'] = q.actionPrefix;
      where.push('startsWith(action, {action_prefix:String})');
    }
    if (q.since) {
      params['since'] = q.since;
      where.push("occurred_at >= {since:DateTime64(3, 'UTC')}");
    }
    if (q.until) {
      params['until'] = q.until;
      where.push("occurred_at < {until:DateTime64(3, 'UTC')}");
    }
    if (q.before) {
      Object.assign(params, { b_at: q.before.occurredAt, b_id: q.before.id });
      // String order of ids, as the postgres driver and the merged read sort them.
      where.push("(occurred_at < {b_at:DateTime64(3, 'UTC')} OR (occurred_at = {b_at:DateTime64(3, 'UTC')} AND toString(id) < {b_id:String}))");
    }
    const rows = await this.ch.query<RecordRow>(
      `SELECT ${COLUMNS} FROM audit_records ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY occurred_at DESC, id_s DESC, ingested_at ${FIRST_COPY} LIMIT {limit:UInt32}`,
      params,
    );
    return rows.map(toRecord);
  }

  async unsealed(limit: number): Promise<AuditRecord[]> {
    const rows = await this.ch.query<RecordRow>(
      `SELECT ${COLUMNS} FROM audit_records
        WHERE ingested_at >= (
                SELECT coalesce(max(ingested_at), toDateTime64(0, 6, 'UTC')) FROM audit_records
                 WHERE id IN (SELECT record_id FROM audit_chain WHERE position + 100 > (SELECT max(position) FROM audit_chain))
              ) - INTERVAL 1 HOUR
          AND id NOT IN (SELECT record_id FROM audit_chain)
        ORDER BY ingested_at, id_s ${FIRST_COPY} LIMIT {limit:UInt32}`,
      { limit },
    );
    return rows.map(toRecord);
  }

  async chainHead(): Promise<ChainEntry | null> {
    const [row] = await this.ch.query<ChainRow>(`SELECT ${CHAIN_COLUMNS} FROM audit_chain ORDER BY position DESC LIMIT 1`);
    return row ? toEntry(row) : null;
  }

  /**
   * Callers are the leader's sealer (fenced by a lock in the main database). ClickHouse has no
   * unique position, so the insert's deduplication token is the first position alone: a second
   * sealer inserting at a position already written is dropped. Reading the position back then
   * tells the loser it lost (it throws and retries from the real head) instead of forking.
   */
  async appendChain(entries: readonly ChainEntry[]): Promise<void> {
    if (!entries.length) return;
    const first = entries[0]!;
    assertContinues(await this.chainHead(), entries);
    await this.ch.insert(
      'audit_chain',
      entries.map((e) => ({
        position: e.position,
        record_id: e.recordId,
        record_occurred_at: chDateTime(e.recordOccurredAt),
        record_hash: e.recordHash,
        prev_hash: e.prevHash,
        chain_hash: e.chainHash,
        sealed_at: chDateTime(e.sealedAt),
      })),
      { insert_deduplication_token: `chain-${first.position}` },
    );
    const stored = await this.ch.query<{ chain_hash: string }>('SELECT chain_hash FROM audit_chain WHERE position = {p:UInt64}', { p: first.position });
    if (stored.some((r) => r.chain_hash !== first.chainHash)) {
      throw new Error(`audit chain: position ${first.position} was sealed concurrently by another sealer; retry from the head`);
    }
  }

  async appendCheckpoint(c: Checkpoint): Promise<void> {
    await this.ch.insert(
      'audit_checkpoints',
      [{ id: c.id, up_to_position: c.upToPosition, chain_hash: c.chainHash, created_at: chDateTime(c.createdAt), key_id: c.keyId, signature: c.signature }],
      { insert_deduplication_token: `checkpoint-${c.id}` },
    );
  }

  async checkpoints(q: CheckpointQuery): Promise<Checkpoint[]> {
    const params: Record<string, ClickHouseParam> = { limit: q.limit };
    const where: string[] = [];
    if (q.since) {
      params['since'] = q.since;
      where.push("created_at >= {since:DateTime64(3, 'UTC')}");
    }
    if (q.fromPosition !== undefined) {
      params['from_p'] = q.fromPosition;
      where.push('up_to_position >= {from_p:UInt64}');
    }
    if (q.toPosition !== undefined) {
      params['to_p'] = q.toPosition;
      where.push('up_to_position <= {to_p:UInt64}');
    }
    const rows = await this.ch.query<CheckpointRow>(
      `SELECT toString(id) AS id_s, up_to_position, chain_hash, created_at, key_id, signature FROM audit_checkpoints
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY up_to_position DESC, created_at DESC LIMIT 1 BY id_s LIMIT {limit:UInt32}`,
      params,
    );
    return rows.map(toCheckpoint);
  }

  async chainRange(fromPosition: number, limit: number): Promise<ChainRangeItem[]> {
    const entries = (
      await this.ch.query<ChainRow>(`SELECT ${CHAIN_COLUMNS} FROM audit_chain WHERE position >= {from:UInt64} ORDER BY position, sealed_at LIMIT 1 BY position LIMIT {limit:UInt32}`, {
        from: fromPosition,
        limit,
      })
    ).map(toEntry);
    if (!entries.length) return [];
    const ids = entries.map((e) => e.recordId);
    const [records, forks] = await Promise.all([
      this.ch.query<RecordRow>(`SELECT ${COLUMNS} FROM audit_records WHERE id IN {ids:Array(UUID)} ORDER BY id_s, ingested_at`, { ids }),
      // Other chain rows at these positions, or sealing these records, with another chain hash.
      this.ch.query<{ position: number | string; record_id_s: string; chain_hash: string }>(
        `SELECT DISTINCT position, toString(record_id) AS record_id_s, chain_hash FROM audit_chain
          WHERE position BETWEEN {lo:UInt64} AND {hi:UInt64} OR record_id IN {ids:Array(UUID)}`,
        { lo: entries[0]!.position, hi: entries[entries.length - 1]!.position, ids },
      ),
    ]);
    const copies = new Map<string, AuditRecord[]>();
    for (const r of records) copies.set(r.id_s, [...(copies.get(r.id_s) ?? []), toRecord(r)]);
    return entries.map((entry) => {
      const stored = copies.get(entry.recordId) ?? [];
      const record = stored[0] ?? null;
      const conflicts = record ? new Set(stored.map((r) => recordHash(r))).size - 1 : 0;
      // Distinct chain rows touching this position or this record, other than the entry itself.
      const others = forks.filter(
        (f) => (Number(f.position) === entry.position || f.record_id_s === entry.recordId) && !(Number(f.position) === entry.position && f.record_id_s === entry.recordId && f.chain_hash === entry.chainHash),
      ).length;
      const item: ChainRangeItem = { entry, record };
      if (others) item.forks = others;
      if (conflicts) item.conflicts = conflicts;
      return item;
    });
  }

  /** Drops whole monthly partitions that end on or before the floored cutoff, as the purge user, and logs the drop. */
  async purgeBefore(cutoff: Date): Promise<number> {
    if (!this.purge) throw new Error('the clickhouse audit store purges only with CLICKHOUSE_PURGE_USER (worker); nothing was removed');
    const [config] = await this.purge.query<{ days: number | string | null }>('SELECT max(min_retention_days) AS days FROM audit_store_config');
    const floorDays = Math.max(PURGE_FLOOR_DAYS, Number(config?.days ?? 0) || 0);
    const floor = new Date(Date.now() - floorDays * 24 * 3600 * 1000);
    const effective = cutoff < floor ? cutoff : floor;
    const monthStart = new Date(Date.UTC(effective.getUTCFullYear(), effective.getUTCMonth(), 1));
    const parts = await this.purge.query<{ p: number | string; n: number | string }>(
      "SELECT toYYYYMM(occurred_at) AS p, uniqExact(id) AS n FROM audit_records WHERE occurred_at < {before:DateTime64(3, 'UTC')} GROUP BY p ORDER BY p",
      { before: monthStart },
    );
    let removed = 0;
    const dropped: number[] = [];
    for (const { p, n } of parts) {
      const partition = Number(p);
      if (!Number.isInteger(partition) || partition < 190001 || partition > 299912) continue;
      await this.purge.exec(`ALTER TABLE audit_records DROP PARTITION ${partition}`);
      removed += Number(n);
      dropped.push(partition);
    }
    if (dropped.length) {
      const newest = dropped[dropped.length - 1]!;
      const end = new Date(Date.UTC(Math.floor(newest / 100), newest % 100, 1));
      await this.purge.insert('audit_purges', [{ cutoff: chDateTime(end), partitions: dropped, records: removed }]);
    }
    return removed;
  }

  async purgeHorizon(): Promise<Date | null> {
    const [row] = await this.ch.query<{ cutoff: string | null }>('SELECT if(count() = 0, NULL, max(cutoff)) AS cutoff FROM audit_purges');
    return row?.cutoff ? utc(row.cutoff) : null;
  }

  async selfCheck(): Promise<AuditStoreSelfCheck> {
    return checkGrants(await this.ch.exec('SHOW GRANTS'));
  }

  async stats(): Promise<AuditStoreStats> {
    const [range] = await this.ch.query<{ rows: number | string; oldest: string | null; newest: string | null }>(
      'SELECT uniqExact(id) AS rows, if(rows = 0, NULL, min(occurred_at)) AS oldest, if(rows = 0, NULL, max(occurred_at)) AS newest FROM audit_records',
    );
    let bytes: number | null = null;
    try {
      const [size] = await this.ch.query<{ bytes: number | string }>(
        "SELECT sum(bytes_on_disk) AS bytes FROM system.parts WHERE database = {db:String} AND table IN ('audit_records', 'audit_chain', 'audit_checkpoints') AND active",
        { db: this.ch.database },
      );
      bytes = size ? Number(size.bytes) : null;
    } catch {
      bytes = null;
    }
    return { rows: Number(range?.rows ?? 0), bytes, oldest: range?.oldest ? utc(range.oldest) : null, newest: range?.newest ? utc(range.newest) : null };
  }

  async health(): Promise<AuditStoreHealth> {
    const started = performance.now();
    try {
      await this.ch.exec('SELECT 1', { timeoutMs: 5_000 });
      return { ok: true, latencyMs: Math.round(performance.now() - started) };
    } catch (err) {
      return { ok: false, latencyMs: Math.round(performance.now() - started), detail: (err as Error).name === 'ClickHouseError' ? `http ${(err as { status: number }).status}` : 'unreachable' };
    }
  }

  async close(): Promise<void> {}
}
