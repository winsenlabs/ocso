/**
 * The audit store contract (PM/research/11 §6.1, ADR-032). The main database
 * keeps writing `audit_events` in the same transaction as each change (the
 * transactional outbox); the worker ships those rows here. The store is the
 * system of record: append-only, idempotent on id, sealed into a hash chain
 * with Ed25519-signed checkpoints. A driver (postgres, clickhouse, …) is
 * selected by AUDIT_DRIVER at bootstrap; core code only sees this interface.
 */

/** One audit event as the store keeps it. Mirrors `audit_events` plus the teams it concerns. */
export interface AuditRecord {
  id: string;
  occurredAt: Date;
  actorType: string;
  actorId: string | null;
  actorName: string | null;
  via: string;
  action: string;
  targetType: string;
  targetId: string | null;
  summary: string;
  before: unknown;
  after: unknown;
  correlationId: string | null;
  confirmation: unknown;
  ip: string | null;
  /** Target's teams ∪ actor's teams at write time (the read scope, since the store cannot join the main database). */
  teamIds: readonly string[];
}

/**
 * Which records a reader may see. `null` = everything (`audit.read_all`).
 * Otherwise a record is visible when the reader is its actor, it concerns one
 * of the reader's teams, or its target type is shared configuration.
 */
export type AuditScopeFilter = null | {
  actorId: string;
  teamIds: readonly string[];
  sharedTargetTypes: readonly string[];
};

/** Filters of a store read; ordered `(occurredAt, id)` descending, keyset-paginated by `before`. */
export interface AuditStoreQuery {
  targetType?: string | undefined;
  targetTypes?: readonly string[] | undefined;
  targetId?: string | undefined;
  actorId?: string | undefined;
  via?: string | undefined;
  /** Prefix match on the action, e.g. `alert_rule.` */
  actionPrefix?: string | undefined;
  /** Inclusive lower bound on occurredAt. */
  since?: Date | undefined;
  /** Exclusive upper bound on occurredAt. */
  until?: Date | undefined;
  /** Keyset cursor: rows strictly before this (occurredAt, id). */
  before?: { occurredAt: Date; id: string } | undefined;
  limit: number;
}

/** One link of the hash chain. `chainHash = sha256(prevHash ‖ recordHash)`; position 1 links to the genesis hash. */
export interface ChainEntry {
  position: number;
  recordId: string;
  /** The sealed record's occurredAt: tells a purged record (older than the floor) from a missing one. */
  recordOccurredAt: Date;
  recordHash: string;
  prevHash: string;
  chainHash: string;
  sealedAt: Date;
}

/** An Ed25519 signature over the chain hash at `upToPosition` (see checkpointMessage). */
export interface Checkpoint {
  id: string;
  upToPosition: number;
  chainHash: string;
  createdAt: Date;
  keyId: string;
  /** base64 Ed25519 signature. */
  signature: string;
}

export interface CheckpointQuery {
  since?: Date | undefined;
  /** Only checkpoints with upToPosition in [fromPosition, toPosition]. */
  fromPosition?: number | undefined;
  toPosition?: number | undefined;
  limit: number;
}

export interface AuditStoreStats {
  rows: number;
  bytes: number | null;
  oldest: Date | null;
  newest: Date | null;
}

export interface AuditStoreHealth {
  ok: boolean;
  latencyMs: number;
  detail?: string | undefined;
}

export interface AuditStore {
  /** The AUDIT_DRIVER that built it; display and logs only (core never compares it). */
  readonly driver: string;
  /**
   * How the store scales, for the storage guidance (PM/research/11 §7): a `row` store is outgrown by a very
   * large or fast-growing trail, a `columnar` one is where that trail belongs. `label` names the engine
   * for people. Optional; absent reads as `row`.
   */
  readonly sizing?: { readonly kind: 'row' | 'columnar'; readonly label: string } | undefined;
  /** Idempotent on id: re-appending a stored record is a no-op. */
  append(records: readonly AuditRecord[]): Promise<void>;
  /** The subset of `ids` the store holds (reconciliation). */
  has(ids: readonly string[]): Promise<ReadonlySet<string>>;
  /** `(occurredAt, id)` descending, keyset-paginated. */
  query(q: AuditStoreQuery, scope: AuditScopeFilter): Promise<AuditRecord[]>;
  /** Records not yet in the chain, in the order they reached the store. */
  unsealed(limit: number): Promise<AuditRecord[]>;
  chainHead(): Promise<ChainEntry | null>;
  /** Appends contiguous entries after the current head; refuses a gap, a fork or a broken link. */
  appendChain(entries: readonly ChainEntry[]): Promise<void>;
  appendCheckpoint(c: Checkpoint): Promise<void>;
  /** Newest first. */
  checkpoints(q: CheckpointQuery): Promise<Checkpoint[]>;
  /** Entries from `fromPosition` ascending, each with its record (null once purged, or if missing). */
  chainRange(fromPosition: number, limit: number): Promise<ChainRangeItem[]>;
  /**
   * Removes records older than the cutoff; never anything younger than the store's
   * minimum retention (at least PURGE_FLOOR_DAYS). Every removal is logged in the
   * store (purgeHorizon). Returns records removed.
   */
  purgeBefore(cutoff: Date): Promise<number>;
  /** Records older than this were removed by a logged purge; null = nothing was ever purged. */
  purgeHorizon(): Promise<Date | null>;
  stats(): Promise<AuditStoreStats>;
  health(): Promise<AuditStoreHealth>;
  /** What these credentials may do in the store, and any weakness to show operators. */
  selfCheck(): Promise<AuditStoreSelfCheck>;
  close(): Promise<void>;
}

/** One chain position as chainRange reads it. */
export interface ChainRangeItem {
  entry: ChainEntry;
  record: AuditRecord | null;
  /** Other chain rows at this position, or sealing the same record, with a different hash (a fork; stores without a unique position). */
  forks?: number | undefined;
  /** Other stored copies of the record with different content (a record rewritten by a second insert). */
  conflicts?: number | undefined;
}

export interface AuditStoreSelfCheck {
  /** The connected credentials can insert records (writer); false = read-only (the api's reader). */
  canWrite: boolean;
  /** Human-readable weaknesses, e.g. connected as the owner so append-only is not enforced. */
  warnings: string[];
}

/** Nothing younger than this is ever purged from the store, whatever the settings say (the store's own minimum may be higher). */
export const PURGE_FLOOR_DAYS = 365;

/** The floor-adjusted purge cutoff: the earlier of `cutoff` and now − PURGE_FLOOR_DAYS. */
export function flooredCutoff(cutoff: Date, now: Date = new Date()): Date {
  const floor = new Date(now.getTime() - PURGE_FLOOR_DAYS * 24 * 3600 * 1000);
  return cutoff < floor ? cutoff : floor;
}

export interface AuditStoreLogger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
}

/** What a driver gets from the host. `fetch` is the HTTP client for HTTP-based stores (injected, never global). */
export interface AuditStoreDriverDeps {
  logger: AuditStoreLogger;
  fetch?: typeof fetch | undefined;
}

/** Default bound on one store call: a store that stops answering fails fast instead of hanging the caller. */
export const AUDIT_STORE_TIMEOUT_MS = 15_000;
/** Bound on opening a connection. */
export const AUDIT_STORE_CONNECT_TIMEOUT_MS = 5_000;

/** Rejects when `promise` has not settled within `ms` (the work itself is bounded by the driver's own timeouts). */
export function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`${what} did not answer within ${ms} ms`), { code: 'AUDIT_STORE_TIMEOUT' })), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export interface AuditProvisionOptions {
  log: (msg: string) => void;
}

export interface AuditProvisionReport {
  applied: string[];
  writer: string;
  /** The read-only role/user for the api, when configured. */
  reader: string | null;
  roleProvisioned: boolean;
}

/**
 * An audit store driver: registered by name (an OcsoPlugin's `auditStoreDrivers`),
 * selected by AUDIT_DRIVER. `check` lists missing settings (start-up fails naming
 * each); `create` builds the process-wide store with the writer credentials;
 * `provision` (the audit-migrate step, owner credentials) applies the driver's
 * schema and ensures the writer role.
 */
export interface AuditStoreDriverDefinition<Env, MigrateEnv = Env> {
  readonly name: string;
  readonly check?: ((env: Env) => readonly string[]) | undefined;
  readonly create: (env: Env, deps: AuditStoreDriverDeps) => AuditStore;
  readonly provision?: ((env: MigrateEnv, options: AuditProvisionOptions) => Promise<AuditProvisionReport>) | undefined;
}
