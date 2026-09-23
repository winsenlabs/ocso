import { GENESIS_HASH, chainHash, recordHash } from './canonical.js';
import type { AuditRecord, AuditStore, ChainEntry, Checkpoint } from './contract.js';
import { verifyCheckpoint, type AuditPublicKey } from './signing.js';

/** The chain entries sealing `records` in order after `head` (null = empty chain). */
export function extendChain(head: Pick<ChainEntry, 'position' | 'chainHash'> | null, records: readonly AuditRecord[], sealedAt: Date = new Date()): ChainEntry[] {
  let position = head?.position ?? 0;
  let prev = head?.chainHash ?? GENESIS_HASH;
  const sealed = new Date(Math.floor(sealedAt.getTime()));
  return records.map((record) => {
    const rh = recordHash(record);
    const entry: ChainEntry = { position: ++position, recordId: record.id, recordOccurredAt: record.occurredAt, recordHash: rh, prevHash: prev, chainHash: chainHash(prev, rh), sealedAt: sealed };
    prev = entry.chainHash;
    return entry;
  });
}

/** Refuses entries that do not continue `head` exactly (used by drivers before writing). */
export function assertContinues(head: Pick<ChainEntry, 'position' | 'chainHash'> | null, entries: readonly ChainEntry[]): void {
  let position = head?.position ?? 0;
  let prev = head?.chainHash ?? GENESIS_HASH;
  for (const e of entries) {
    if (e.position !== position + 1) throw new Error(`audit chain: expected position ${position + 1}, got ${e.position}`);
    if (e.prevHash !== prev) throw new Error(`audit chain: entry ${e.position} does not link to the head`);
    if (chainHash(e.prevHash, e.recordHash) !== e.chainHash) throw new Error(`audit chain: entry ${e.position} has a wrong chain hash`);
    position = e.position;
    prev = e.chainHash;
  }
}

export type ChainProblemKind =
  | 'POSITION_GAP'
  | 'CHAIN_LINK_BROKEN'
  | 'CHAIN_HASH_MISMATCH'
  | 'RECORD_HASH_MISMATCH'
  | 'RECORD_MISSING'
  | 'CHECKPOINT_MISMATCH'
  | 'CHECKPOINT_SIGNATURE_INVALID'
  | 'CHECKPOINT_UNKNOWN_KEY'
  /** Two different chain rows at one position, or one record sealed twice. */
  | 'CHAIN_FORK'
  /** The store holds another copy of a sealed record with different content. */
  | 'RECORD_CONFLICT'
  /** The range has no valid checkpoint, or too long an unsigned tail (requireCheckpoint / maxUnsignedTail). */
  | 'UNSIGNED';

export interface ChainProblem {
  kind: ChainProblemKind;
  position: number;
  recordId?: string | undefined;
  detail: string;
}

export interface ChainVerification {
  ok: boolean;
  /** Verified range (inclusive); from > to when the chain is empty. */
  from: number;
  to: number;
  head: number | null;
  entries: number;
  /** Records present and re-hashed. */
  records: number;
  /** Records gone because a logged purge removed them (older than the store's purge horizon; their hashes still link). */
  purged: number;
  checkpoints: { checked: number; valid: number; latest: Checkpoint | null };
  problems: ChainProblem[];
  /** The range was longer than `maxEntries`; `to` is where verification stopped. */
  truncated: boolean;
  verifiedAt: Date;
}

export interface VerifyOptions {
  from?: number | undefined;
  to?: number | undefined;
  /** Trusted public keys (the deployment's); checkpoints signed by another key are reported. */
  keys: readonly AuditPublicKey[];
  now?: Date | undefined;
  batch?: number | undefined;
  maxEntries?: number | undefined;
  maxProblems?: number | undefined;
  /** Report UNSIGNED when entries were checked but no valid checkpoint lies in the range. */
  requireCheckpoint?: boolean | undefined;
  /** Report UNSIGNED when more than this many entries follow the last valid checkpoint (up to `to`). */
  maxUnsignedTail?: number | undefined;
}

/**
 * Re-verifies a range of the chain against the store: every link, every
 * record's hash, and every checkpoint's chain hash and signature in the range.
 * Read-only; the auditor's tool (`audit-verify`, POST /v1/audit/verify) and the
 * sealer's check before it signs a new checkpoint.
 */
export async function verifyChain(store: Pick<AuditStore, 'chainHead' | 'chainRange' | 'checkpoints' | 'purgeHorizon'>, options: VerifyOptions): Promise<ChainVerification> {
  const now = options.now ?? new Date();
  const batch = Math.max(1, options.batch ?? 1000);
  const maxEntries = options.maxEntries ?? 1_000_000;
  const maxProblems = options.maxProblems ?? 100;
  const head = await store.chainHead();
  const from = Math.max(1, options.from ?? 1);
  const requestedTo = Math.min(head?.position ?? 0, options.to ?? Number.MAX_SAFE_INTEGER);
  const to = Math.min(requestedTo, from + maxEntries - 1);
  const result: ChainVerification = {
    ok: true, from, to, head: head?.position ?? null, entries: 0, records: 0, purged: 0,
    checkpoints: { checked: 0, valid: 0, latest: null }, problems: [], truncated: to < requestedTo, verifiedAt: now,
  };
  if (!head || from > to) return result;

  const problem = (p: ChainProblem) => {
    if (result.problems.length < maxProblems) result.problems.push(p);
    result.ok = false;
  };
  // Only a purge the store logged explains a missing record; anything else is RECORD_MISSING.
  const horizon = await store.purgeHorizon();
  let lastValidCheckpoint = 0;
  const cps = await store.checkpoints({ fromPosition: from, toPosition: to, limit: 100_000 });
  result.checkpoints.latest = cps[0] ?? null;
  const byPosition = new Map<number, Checkpoint[]>();
  for (const c of cps) byPosition.set(c.upToPosition, [...(byPosition.get(c.upToPosition) ?? []), c]);

  let prev = GENESIS_HASH;
  if (from > 1) {
    const [before] = await store.chainRange(from - 1, 1);
    if (!before || before.entry.position !== from - 1) problem({ kind: 'POSITION_GAP', position: from - 1, detail: 'the entry before the range is missing' });
    else prev = before.entry.chainHash;
  }
  let expected = from;
  while (expected <= to) {
    const page = await store.chainRange(expected, Math.min(batch, to - expected + 1));
    if (!page.length) {
      problem({ kind: 'POSITION_GAP', position: expected, detail: `entries ${expected}–${to} are missing` });
      break;
    }
    for (const { entry, record, forks, conflicts } of page) {
      if (entry.position > to) {
        problem({ kind: 'POSITION_GAP', position: expected, detail: `entries ${expected}–${to} are missing` });
        expected = to + 1;
        break;
      }
      if (entry.position !== expected) problem({ kind: 'POSITION_GAP', position: expected, detail: `next entry is ${entry.position}` });
      result.entries++;
      if (entry.prevHash !== prev) problem({ kind: 'CHAIN_LINK_BROKEN', position: entry.position, recordId: entry.recordId, detail: 'prevHash does not match the previous entry' });
      if (chainHash(entry.prevHash, entry.recordHash) !== entry.chainHash) problem({ kind: 'CHAIN_HASH_MISMATCH', position: entry.position, recordId: entry.recordId, detail: 'chainHash is not sha256(prevHash ‖ recordHash)' });
      if (forks) problem({ kind: 'CHAIN_FORK', position: entry.position, recordId: entry.recordId, detail: `${forks} other chain row(s) at this position or sealing this record` });
      if (conflicts) problem({ kind: 'RECORD_CONFLICT', position: entry.position, recordId: entry.recordId, detail: `${conflicts} other stored cop(ies) of this record with different content` });
      if (!record) {
        if (horizon && entry.recordOccurredAt < horizon) result.purged++;
        else problem({ kind: 'RECORD_MISSING', position: entry.position, recordId: entry.recordId, detail: 'the sealed record is not in the store' });
      } else {
        result.records++;
        if (record.id !== entry.recordId || recordHash(record) !== entry.recordHash) {
          problem({ kind: 'RECORD_HASH_MISMATCH', position: entry.position, recordId: entry.recordId, detail: 'the stored record no longer matches its sealed hash' });
        }
      }
      for (const c of byPosition.get(entry.position) ?? []) {
        result.checkpoints.checked++;
        if (c.chainHash !== entry.chainHash) {
          problem({ kind: 'CHECKPOINT_MISMATCH', position: entry.position, detail: `checkpoint ${c.id} signs a different chain hash` });
          continue;
        }
        const status = verifyCheckpoint(c, options.keys);
        if (status === 'VALID') {
          result.checkpoints.valid++;
          lastValidCheckpoint = Math.max(lastValidCheckpoint, entry.position);
        }
        else problem({ kind: status === 'INVALID' ? 'CHECKPOINT_SIGNATURE_INVALID' : 'CHECKPOINT_UNKNOWN_KEY', position: entry.position, detail: `checkpoint ${c.id} (key ${c.keyId})` });
      }
      prev = entry.chainHash;
      expected = entry.position + 1;
    }
  }
  if (options.requireCheckpoint && result.entries > 0 && result.checkpoints.valid === 0) {
    problem({ kind: 'UNSIGNED', position: to, detail: `no valid checkpoint signs any of entries ${from}–${to}` });
  } else if (options.maxUnsignedTail !== undefined && result.entries > 0 && to - Math.max(lastValidCheckpoint, from - 1) > options.maxUnsignedTail) {
    problem({ kind: 'UNSIGNED', position: to, detail: `${to - Math.max(lastValidCheckpoint, from - 1)} entries follow the last valid checkpoint (at most ${options.maxUnsignedTail} expected)` });
  }
  return result;
}
