import { sql } from 'drizzle-orm';
import { extendChain, signCheckpoint, trustedKeys, verifyChain, type AuditSigner, type AuditStore, type Checkpoint } from '@ocso/audit-store';
import { uuidv7, type Db } from '@ocso/db';
import { acknowledgedBreaks, advanceChainBreak, noteChainBreak, outsideRanges, type ChainBreakDetail } from './chain-health.js';
import { openAuditIncident, recordAuditIncident } from './incidents.js';

export interface SealResult {
  sealed: number;
  head: number | null;
  checkpoint: Checkpoint | null;
  /** New problems since the last check: nothing was signed this run (CHAIN_BROKEN). */
  broken?: boolean;
  /** Another sealer holds the lock (an overlapping leader): this run did nothing. */
  skipped?: boolean;
}

export interface SealerOptions {
  batch?: number;
  maxRounds?: number;
  /** New checkpoint after this many entries… */
  checkpointEvery?: number;
  /** …or this long after the last one, when anything was sealed since. */
  checkpointIntervalMs?: number;
  /** Entries re-verified per run at most; a longer range is checkpointed in steps. */
  maxVerifyEntries?: number;
  now?: () => Date;
}

/** Main-database advisory lock that fences the sealer: two overlapping leaders never seal at once. */
const SEAL_LOCK = sql`SELECT pg_try_advisory_xact_lock(hashtext('ocso:audit-seal')) AS locked`;

/**
 * audit-seal (PM/research/11 §6.3): extends the hash chain over the records
 * the store has not sealed yet, in arrival order, then signs a checkpoint every
 * 1 000 entries or hourly. Before signing it re-verifies only what is new since
 * the last checkpoint (or since the last check of a known break), at most
 * `maxVerifyEntries` per run, and signs the verified end. New problems open or
 * widen CHAIN_BROKEN and sign nothing; later ranges that verify on their own
 * are still checkpointed, so exports continue and the break stays recorded
 * until someone acknowledges it. A checkpoint by a key the deployment does not
 * trust opens SIGNING_KEY_CHANGED. Fenced by a main-database advisory lock
 * (stores without a unique chain position, like ClickHouse, rely on it).
 * Leader-only; without a signing key it still chains.
 */
export class AuditSealer {
  constructor(
    private readonly db: Db,
    private readonly store: AuditStore,
    private readonly signer: AuditSigner | null,
    private readonly options: SealerOptions = {},
  ) {}

  async seal(): Promise<SealResult> {
    return this.db.transaction(async (tx) => {
      const { rows } = await tx.execute<{ locked: boolean }>(SEAL_LOCK);
      if (!rows[0]?.locked) return { sealed: 0, head: null, checkpoint: null, skipped: true };
      return this.sealLocked();
    });
  }

  private async sealLocked(): Promise<SealResult> {
    let sealed = 0;
    for (let round = 0; round < (this.options.maxRounds ?? 10); round++) {
      const records = await this.store.unsealed(this.options.batch ?? 1000);
      if (!records.length) break;
      await this.store.appendChain(extendChain(await this.store.chainHead(), records, this.now()));
      sealed += records.length;
    }
    const head = await this.store.chainHead();
    if (!head || !this.signer) return { sealed, head: head?.position ?? null, checkpoint: null };
    const keys = trustedKeys(this.signer);
    const [last] = await this.store.checkpoints({ limit: 1 });
    if (last && !keys.some((k) => k.keyId === last.keyId)) {
      await recordAuditIncident(this.db, 'SIGNING_KEY_CHANGED', { previousKeyId: last.keyId, currentKeyId: this.signer.keyId, upToPosition: last.upToPosition, hint: 'add the previous public key to AUDIT_TRUSTED_PUBLIC_KEYS_FILE, or restore the signing key' });
    }
    const open = await openAuditIncident(this.db, 'CHAIN_BROKEN');
    const checkedTo = Number((open?.detail as Partial<ChainBreakDetail> | undefined)?.checkedTo ?? 0);
    const base = Math.max(last?.upToPosition ?? 0, checkedTo);
    const since = head.position - base;
    const intervalDue = since > 0 && this.now().getTime() - (last?.createdAt.getTime() ?? 0) >= (this.options.checkpointIntervalMs ?? 3_600_000);
    if (since <= 0 || (last && since < (this.options.checkpointEvery ?? 1000) && !intervalDue)) return { sealed, head: head.position, checkpoint: null };

    // From the base (inclusive: its link and checkpoint are checked too), bounded.
    const max = this.options.maxVerifyEntries ?? 50_000;
    const report = await verifyChain(this.store, { from: Math.max(1, base), to: head.position, keys, now: this.now(), maxEntries: max });
    const known = await acknowledgedBreaks(this.db);
    // A retired or foreign key is SIGNING_KEY_CHANGED, not a break; what was already recorded is not new.
    const problems = report.problems.filter((p) => p.kind !== 'CHECKPOINT_UNKNOWN_KEY' && p.position > checkedTo).filter(outsideRanges(known));
    if (problems.length) {
      await noteChainBreak(this.db, this.store.driver, problems, report.to, report.problems.length >= 100);
      return { sealed, head: head.position, checkpoint: null, broken: true };
    }
    const end = report.to === head.position ? head : (await this.store.chainRange(report.to, 1))[0]?.entry;
    if (!end || end.position !== report.to) return { sealed, head: head.position, checkpoint: null };
    const checkpoint = signCheckpoint(this.signer, { upToPosition: end.position, chainHash: end.chainHash }, this.now(), uuidv7());
    await this.store.appendCheckpoint(checkpoint);
    if (open) await advanceChainBreak(this.db, end.position);
    return { sealed, head: head.position, checkpoint };
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}
