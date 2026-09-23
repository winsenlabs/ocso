import type { AuditRecord, AuditScopeFilter, AuditStoreQuery, ChainEntry, Checkpoint } from '../contract.js';

/** Column list of audit_records, in the order records are written. */
export const RECORD_COLUMNS =
  'id, occurred_at, actor_type, actor_id, actor_name, via, action, target_type, target_id, summary, before, after, correlation_id, confirmation, ip, team_ids';

/** jsonb_to_recordset column definitions matching RECORD_COLUMNS. */
export const RECORDSET =
  'x(id uuid, occurred_at timestamptz, actor_type text, actor_id text, actor_name text, via text, action text, target_type text, target_id text, summary text, before jsonb, after jsonb, correlation_id text, confirmation jsonb, ip text, team_ids uuid[])';

export interface RecordRow {
  id: string;
  occurred_at: Date;
  actor_type: string;
  actor_id: string | null;
  actor_name: string | null;
  via: string;
  action: string;
  target_type: string;
  target_id: string | null;
  summary: string;
  before: unknown;
  after: unknown;
  correlation_id: string | null;
  confirmation: unknown;
  ip: string | null;
  team_ids: string[] | string | null;
}

/** node-pg parses uuid[] as a string array; be lenient with the text form too. */
function uuidArray(v: string[] | string | null): string[] {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  const inner = v.replace(/^\{|\}$/g, '');
  return inner ? inner.split(',') : [];
}

export function toRecord(r: RecordRow): AuditRecord {
  return {
    id: r.id,
    occurredAt: r.occurred_at,
    actorType: r.actor_type,
    actorId: r.actor_id,
    actorName: r.actor_name,
    via: r.via,
    action: r.action,
    targetType: r.target_type,
    targetId: r.target_id,
    summary: r.summary,
    before: r.before ?? null,
    after: r.after ?? null,
    correlationId: r.correlation_id,
    confirmation: r.confirmation ?? null,
    ip: r.ip,
    teamIds: uuidArray(r.team_ids),
  };
}

/** A record as a jsonb_to_recordset element. */
export function toRecordJson(r: AuditRecord): Record<string, unknown> {
  return {
    id: r.id,
    occurred_at: r.occurredAt.toISOString(),
    actor_type: r.actorType,
    actor_id: r.actorId,
    actor_name: r.actorName,
    via: r.via,
    action: r.action,
    target_type: r.targetType,
    target_id: r.targetId,
    summary: r.summary,
    before: r.before ?? null,
    after: r.after ?? null,
    correlation_id: r.correlationId,
    confirmation: r.confirmation ?? null,
    ip: r.ip,
    team_ids: [...r.teamIds],
  };
}

export interface ChainRow {
  position: string;
  record_id: string;
  record_occurred_at: Date;
  record_hash: string;
  prev_hash: string;
  chain_hash: string;
  sealed_at: Date;
}

export const toChainEntry = (r: ChainRow): ChainEntry => ({
  position: Number(r.position),
  recordId: r.record_id,
  recordOccurredAt: r.record_occurred_at,
  recordHash: r.record_hash,
  prevHash: r.prev_hash,
  chainHash: r.chain_hash,
  sealedAt: r.sealed_at,
});

export interface CheckpointRow {
  id: string;
  up_to_position: string;
  chain_hash: string;
  created_at: Date;
  key_id: string;
  signature: string;
}

export const toCheckpoint = (r: CheckpointRow): Checkpoint => ({
  id: r.id,
  upToPosition: Number(r.up_to_position),
  chainHash: r.chain_hash,
  createdAt: r.created_at,
  keyId: r.key_id,
  signature: r.signature,
});

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** WHERE clause + params for a store query (records alias `r`). */
export function recordFilter(q: AuditStoreQuery, scope: AuditScopeFilter): { where: string; params: unknown[] } {
  const params: unknown[] = [];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const clauses: string[] = [];
  if (scope) {
    clauses.push(`(r.actor_id = ${p(scope.actorId)} OR r.team_ids && ${p([...scope.teamIds])}::uuid[] OR r.target_type = ANY(${p([...scope.sharedTargetTypes])}::text[]))`);
  }
  if (q.targetType) clauses.push(`r.target_type = ${p(q.targetType)}`);
  if (q.targetTypes?.length) clauses.push(`r.target_type = ANY(${p([...q.targetTypes])}::text[])`);
  if (q.targetId) clauses.push(`r.target_id = ${p(q.targetId)}`);
  if (q.actorId) clauses.push(`r.actor_id = ${p(q.actorId)}`);
  if (q.via) clauses.push(`r.via = ${p(q.via)}`);
  if (q.actionPrefix) clauses.push(`r.action LIKE ${p(`${escapeLike(q.actionPrefix)}%`)}`);
  if (q.since) clauses.push(`r.occurred_at >= ${p(q.since)}`);
  if (q.until) clauses.push(`r.occurred_at < ${p(q.until)}`);
  if (q.before) clauses.push(`(r.occurred_at, r.id) < (${p(q.before.occurredAt)}, ${p(q.before.id)}::uuid)`);
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}
