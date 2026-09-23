import { desc, sql } from 'drizzle-orm';
import { trustedKeys, verifyChain, withTimeout, type AuditPublicKey, type AuditSigner, type AuditStore, type ChainVerification } from '@ocso/audit-store';
import { auditEvents, auditExports, type Db } from '@ocso/db';
import { lastFullVerification } from './chain-health.js';
import { listAuditIncidents, type AuditIncident } from './incidents.js';
import { storeError } from './shipping.js';

/** Shipping lag above this makes the store DEGRADED on the System screen. */
export const AUDIT_LAG_WARNING_SECONDS = 60;

export interface AuditStoreStatus {
  driver: string;
  status: 'OK' | 'DEGRADED' | 'DOWN';
  health: { ok: boolean; latencyMs: number; detail?: string | undefined };
  /** Age of the oldest event not in the store yet (0 = none waiting). */
  lagSeconds: number;
  unshipped: number;
  /** Shipped, not yet confirmed by reconciliation. */
  unverified: number;
  sealedPosition: number | null;
  lastCheckpoint: { id: string; upToPosition: number; createdAt: Date; keyId: string } | null;
  store: { rows: number; bytes: number | null; oldest: Date | null; newest: Date | null } | null;
  exports: { count: number; last: { fromPosition: number; toPosition: number; records: number; manifestKey: string; createdAt: Date } | null };
  incidents: Array<Pick<AuditIncident, 'id' | 'kind' | 'count' | 'firstSeen' | 'lastSeen' | 'detail'>>;
  signingKey: { keyId: string; retired: string[] } | null;
  /** The last finished full-chain verification (audit-verify-full). */
  fullVerification: { finishedAt: Date; ok: boolean; entries: number; checkedTo: number; problems: number } | null;
  /** Weaknesses in how this process reaches the store (e.g. owner credentials, an api with write access). */
  warnings: string[];
  error?: string | undefined;
}

export interface AuditStatusOptions {
  /** The caller should hold read-only credentials (the api in production): warn when it can write. */
  expectReadOnly?: boolean;
}

/**
 * The audit store panel (System screen) and the health dependency report: the
 * outbox side from the main database, the store side from the store. A store
 * that does not answer is DOWN, never an error — readiness does not depend on it.
 */
export async function auditStoreStatus(db: Db, store: AuditStore, signer: AuditSigner | null, options: AuditStatusOptions = {}): Promise<AuditStoreStatus> {
  const [outbox] = await db
    .select({
      unshipped: sql<number>`count(*) FILTER (WHERE ${auditEvents.shippedAt} IS NULL)::int`,
      oldest: sql<string | null>`min(${auditEvents.occurredAt}) FILTER (WHERE ${auditEvents.shippedAt} IS NULL)`,
      unverified: sql<number>`count(*) FILTER (WHERE ${auditEvents.shippedAt} IS NOT NULL AND ${auditEvents.verifiedAt} IS NULL)::int`,
    })
    .from(auditEvents)
    .where(sql`${auditEvents.shippedAt} IS NULL OR ${auditEvents.verifiedAt} IS NULL`);
  const [exportCount] = await db.select({ n: sql<number>`count(*)::int` }).from(auditExports);
  const [lastExport] = await db.select().from(auditExports).orderBy(desc(auditExports.toPosition)).limit(1);
  const incidents = await listAuditIncidents(db, { openOnly: true, limit: 20 });
  const full = await lastFullVerification(db);
  const health = await store.health();
  const oldest = outbox?.oldest ? new Date(outbox.oldest) : null;
  const lagSeconds = oldest ? Math.max(0, Math.round((Date.now() - oldest.getTime()) / 1000)) : 0;
  const status: AuditStoreStatus = {
    driver: store.driver,
    status: !health.ok ? 'DOWN' : lagSeconds > AUDIT_LAG_WARNING_SECONDS || incidents.length ? 'DEGRADED' : 'OK',
    health,
    lagSeconds,
    unshipped: outbox?.unshipped ?? 0,
    unverified: outbox?.unverified ?? 0,
    sealedPosition: null,
    lastCheckpoint: null,
    store: null,
    exports: {
      count: exportCount?.n ?? 0,
      last: lastExport ? { fromPosition: lastExport.fromPosition, toPosition: lastExport.toPosition, records: lastExport.records, manifestKey: lastExport.manifestKey, createdAt: lastExport.createdAt } : null,
    },
    incidents: incidents.map(({ id, kind, count, firstSeen, lastSeen, detail }) => ({ id, kind, count, firstSeen, lastSeen, detail })),
    signingKey: signer ? { keyId: signer.keyId, retired: (signer.retiredKeys ?? []).map((k) => k.keyId) } : null,
    fullVerification: full?.finishedAt ? { finishedAt: full.finishedAt, ok: full.ok, entries: full.entries, checkedTo: full.checkedTo, problems: full.problems.length } : null,
    warnings: [],
  };
  if (!health.ok) return status;
  try {
    const [head, [checkpoint], stats, self] = await withTimeout(
      Promise.all([store.chainHead(), store.checkpoints({ limit: 1 }), store.stats(), store.selfCheck()]),
      10_000,
      'the audit store',
    );
    status.warnings.push(...self.warnings);
    if (options.expectReadOnly && self.canWrite) {
      status.warnings.push('the api holds write access to the audit store: give it the read-only reader credentials (AUDIT_READER_URL / CLICKHOUSE_READER_USER)');
    }
    status.sealedPosition = head?.position ?? null;
    status.lastCheckpoint = checkpoint ? { id: checkpoint.id, upToPosition: checkpoint.upToPosition, createdAt: checkpoint.createdAt, keyId: checkpoint.keyId } : null;
    status.store = stats;
  } catch (err) {
    status.status = 'DEGRADED';
    status.error = storeError(err);
  }
  return status;
}

/** The keys audit signatures verify against: the current signing key, then retired ones (AUDIT_TRUSTED_PUBLIC_KEYS_FILE). */
export function auditPublicKeys(signer: AuditSigner | null): AuditPublicKey[] {
  return trustedKeys(signer);
}

export const VERIFY_MAX_ENTRIES = 100_000;
export const VERIFY_DEFAULT_ENTRIES = 10_000;

/**
 * POST /v1/audit/verify: re-verifies a chain range (default: the latest
 * VERIFY_DEFAULT_ENTRIES entries; at most VERIFY_MAX_ENTRIES per call — the
 * audit-verify bin has no cap; the audit-verify-full task covers the whole chain).
 */
export async function verifyAuditRange(store: AuditStore, signer: AuditSigner | null, range: { from?: number | undefined; to?: number | undefined }): Promise<ChainVerification> {
  let from = range.from;
  if (from === undefined) {
    const head = await store.chainHead();
    const to = range.to ?? head?.position ?? 0;
    from = Math.max(1, to - VERIFY_DEFAULT_ENTRIES + 1);
  }
  return verifyChain(store, { from, to: range.to, keys: auditPublicKeys(signer), maxEntries: VERIFY_MAX_ENTRIES });
}
