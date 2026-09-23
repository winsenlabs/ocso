import type { AuditRecord, ChainEntry, Checkpoint } from '../contract.js';

/** Row shapes of the clickhouse driver's tables (JSONEachRow) and their mapping to the contract. */
export interface RecordRow {
  id_s: string;
  occurred_at: string;
  actor_type: string;
  actor_id: string | null;
  actor_name: string | null;
  via: string;
  action: string;
  target_type: string;
  target_id: string | null;
  summary: string;
  before: string | null;
  after: string | null;
  correlation_id: string | null;
  confirmation: string | null;
  ip: string | null;
  team_ids_s: string[];
}

export interface ChainRow {
  position: number | string;
  record_id_s: string;
  record_occurred_at: string;
  record_hash: string;
  prev_hash: string;
  chain_hash: string;
  sealed_at: string;
}

export interface CheckpointRow {
  id_s: string;
  up_to_position: number | string;
  chain_hash: string;
  created_at: string;
  key_id: string;
  signature: string;
}

/** Aliases never shadow a column name (ClickHouse resolves aliases in WHERE/ORDER BY). */
export const COLUMNS = 'toString(id) AS id_s, occurred_at, actor_type, actor_id, actor_name, via, action, target_type, target_id, summary, before, after, correlation_id, confirmation, ip, arrayMap(t -> toString(t), team_ids) AS team_ids_s';
/** ClickHouse returns ISO without a zone for DateTime64 in some versions; the columns are UTC. */
export const utc = (s: string) => new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s.replace(' ', 'T')}Z`);
export const json = (v: unknown) => (v === null || v === undefined ? null : JSON.stringify(v));
const parse = (s: string | null): unknown => (s === null ? null : JSON.parse(s));

export const toRecord = (r: RecordRow): AuditRecord => ({
  id: r.id_s,
  occurredAt: utc(r.occurred_at),
  actorType: r.actor_type,
  actorId: r.actor_id,
  actorName: r.actor_name,
  via: r.via,
  action: r.action,
  targetType: r.target_type,
  targetId: r.target_id,
  summary: r.summary,
  before: parse(r.before),
  after: parse(r.after),
  correlationId: r.correlation_id,
  confirmation: parse(r.confirmation),
  ip: r.ip,
  teamIds: r.team_ids_s,
});

export const toEntry = (r: ChainRow): ChainEntry => ({
  position: Number(r.position),
  recordId: r.record_id_s,
  recordOccurredAt: utc(r.record_occurred_at),
  recordHash: r.record_hash,
  prevHash: r.prev_hash,
  chainHash: r.chain_hash,
  sealedAt: utc(r.sealed_at),
});

export const toCheckpoint = (r: CheckpointRow): Checkpoint => ({
  id: r.id_s,
  upToPosition: Number(r.up_to_position),
  chainHash: r.chain_hash,
  createdAt: utc(r.created_at),
  keyId: r.key_id,
  signature: r.signature,
});

export const CHAIN_COLUMNS = 'position, toString(record_id) AS record_id_s, record_occurred_at, record_hash, prev_hash, chain_hash, sealed_at';
