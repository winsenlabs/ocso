import { describe, expect, it } from 'vitest';
import { GENESIS_HASH } from '../src/canonical.js';
import { assertContinues, extendChain, verifyChain } from '../src/chain.js';
import { utcMonthKey, type AuditPurge, type AuditRecord, type ChainEntry, type Checkpoint, type CheckpointQuery } from '../src/contract.js';
import { generateSigningKeyPem, loadSigningKey, publicKeyOf, signCheckpoint } from '../src/signing.js';
import { daysAgo, recordAt } from './support.js';

const signer = loadSigningKey(generateSigningKeyPem());
const keys = [publicKeyOf(signer)];

/** The read side of a store, in memory: what verifyChain needs. */
class MemoryChain {
  entries: ChainEntry[] = [];
  records = new Map<string, AuditRecord>();
  cps: Checkpoint[] = [];
  purgeLog: AuditPurge[] = [];
  forks = new Map<number, number>();
  conflicts = new Map<number, number>();
  seal(records: AuditRecord[]) {
    const added = extendChain(this.entries.at(-1) ?? null, records);
    assertContinues(this.entries.at(-1) ?? null, added);
    this.entries.push(...added);
    for (const r of records) this.records.set(r.id, r);
  }
  async chainHead() {
    return this.entries.at(-1) ?? null;
  }
  async chainRange(from: number, limit: number) {
    return this.entries
      .filter((e) => e.position >= from)
      .slice(0, limit)
      .map((entry) => ({ entry, record: this.records.get(entry.recordId) ?? null, forks: this.forks.get(entry.position), conflicts: this.conflicts.get(entry.position) }));
  }
  async purges() {
    return this.purgeLog;
  }
  async checkpoints(q: CheckpointQuery) {
    return this.cps
      .filter((c) => (q.fromPosition === undefined || c.upToPosition >= q.fromPosition) && (q.toPosition === undefined || c.upToPosition <= q.toPosition))
      .sort((a, b) => b.upToPosition - a.upToPosition)
      .slice(0, q.limit);
  }
}

function chainOf(n: number, at = () => new Date()): MemoryChain {
  const m = new MemoryChain();
  m.seal(Array.from({ length: n }, () => recordAt(at())));
  return m;
}

describe('extendChain / assertContinues', () => {
  it('starts at position 1 from the genesis hash and links every entry to the previous one', () => {
    const m = chainOf(3);
    expect(m.entries.map((e) => e.position)).toEqual([1, 2, 3]);
    expect(m.entries[0]!.prevHash).toBe(GENESIS_HASH);
    expect(m.entries[1]!.prevHash).toBe(m.entries[0]!.chainHash);
    m.seal([recordAt(new Date())]);
    expect(m.entries[3]).toMatchObject({ position: 4, prevHash: m.entries[2]!.chainHash });
  });

  it('refuses a gap, a fork and a forged chain hash', () => {
    const m = chainOf(2);
    const head = m.entries[1]!;
    const next = extendChain(head, [recordAt(new Date())]);
    expect(() => assertContinues(head, next.map((e) => ({ ...e, position: 4 })))).toThrow(/expected position 3/);
    expect(() => assertContinues(head, extendChain(m.entries[0]!, [recordAt(new Date())]))).toThrow(/expected position 3/);
    expect(() => assertContinues(head, next.map((e) => ({ ...e, prevHash: 'f'.repeat(64) })))).toThrow(/does not link/);
    expect(() => assertContinues(head, next.map((e) => ({ ...e, chainHash: 'f'.repeat(64) })))).toThrow(/wrong chain hash/);
  });
});

describe('verifyChain', () => {
  it('verifies links, record hashes and checkpoint signatures over a range', async () => {
    const m = chainOf(25);
    m.cps.push(signCheckpoint(signer, { upToPosition: 10, chainHash: m.entries[9]!.chainHash }), signCheckpoint(signer, { upToPosition: 25, chainHash: m.entries[24]!.chainHash }));
    const all = await verifyChain(m, { keys, batch: 7 });
    expect(all).toMatchObject({ ok: true, from: 1, to: 25, head: 25, entries: 25, records: 25, checkpoints: { checked: 2, valid: 2 } });
    const part = await verifyChain(m, { from: 11, to: 20, keys });
    expect(part).toMatchObject({ ok: true, from: 11, to: 20, entries: 10, checkpoints: { checked: 0 } });
    expect(await verifyChain(new MemoryChain(), { keys })).toMatchObject({ ok: true, head: null, entries: 0 });
  });

  it('finds an edited record, a rewritten link and a checkpoint over another hash', async () => {
    const m = chainOf(6);
    const victim = m.entries[2]!;
    m.records.set(victim.recordId, { ...m.records.get(victim.recordId)!, summary: 'edited' });
    m.entries[4] = { ...m.entries[4]!, prevHash: 'e'.repeat(64) };
    m.cps.push(signCheckpoint(signer, { upToPosition: 6, chainHash: 'c'.repeat(64) }));
    const kinds = (await verifyChain(m, { keys })).problems.map((p) => [p.kind, p.position]);
    expect(kinds).toEqual(expect.arrayContaining([['RECORD_HASH_MISMATCH', 3], ['CHAIN_LINK_BROKEN', 5], ['CHAIN_HASH_MISMATCH', 5], ['CHECKPOINT_MISMATCH', 6]]));
  });

  it('counts a record as purged only under a logged purge of its month', async () => {
    const m = new MemoryChain();
    const old = recordAt(daysAgo(400));
    m.seal([old, recordAt(daysAgo(10))]);
    for (const e of m.entries) m.records.delete(e.recordId);
    // No purge was ever logged: an old record gone is still missing (a writer cannot pass off deletion as retention).
    expect((await verifyChain(m, { keys })).problems.map((p) => [p.kind, p.position])).toEqual([['RECORD_MISSING', 1], ['RECORD_MISSING', 2]]);
    m.purgeLog = [{ purgedAt: new Date(), cutoff: daysAgo(380), months: [utcMonthKey(old.occurredAt)] }];
    const report = await verifyChain(m, { keys });
    expect(report.purged).toBe(1);
    expect(report.problems).toEqual([expect.objectContaining({ kind: 'RECORD_MISSING', position: 2 })]);
  });

  it('never trusts a purge cutoff younger than the 365-day floor, nor one for other months', async () => {
    const m = new MemoryChain();
    const old = recordAt(daysAgo(400));
    const recent = recordAt(daysAgo(10));
    m.seal([old, recent]);
    for (const e of m.entries) m.records.delete(e.recordId);
    const future = new Date(Date.now() + 24 * 3600 * 1000);
    // A forged log row: a future cutoff naming both months. The recent record is still missing.
    m.purgeLog = [{ purgedAt: new Date(), cutoff: future, months: [utcMonthKey(old.occurredAt), utcMonthKey(recent.occurredAt)] }];
    let report = await verifyChain(m, { keys });
    expect(report.purged).toBe(1);
    expect(report.problems).toEqual([expect.objectContaining({ kind: 'RECORD_MISSING', position: 2, detail: expect.stringMatching(/claims it/) })]);
    // A purged_at in the future does not help: the cutoff is also clamped to the verifier's clock.
    m.purgeLog = [{ purgedAt: future, cutoff: future, months: [utcMonthKey(recent.occurredAt)] }];
    expect((await verifyChain(m, { keys })).problems.map((p) => [p.kind, p.position])).toEqual([['RECORD_MISSING', 1], ['RECORD_MISSING', 2]]);
    // A cutoff past the record but a purge of another month explains nothing either.
    m.purgeLog = [{ purgedAt: new Date(), cutoff: daysAgo(380), months: [utcMonthKey(daysAgo(700))] }];
    report = await verifyChain(m, { keys });
    expect(report.purged).toBe(0);
    expect(report.problems.map((p) => p.position)).toEqual([1, 2]);
  });

  it('reports forks and conflicting record copies the store reveals', async () => {
    const m = chainOf(3);
    m.forks.set(2, 1);
    m.conflicts.set(3, 1);
    const kinds = (await verifyChain(m, { keys })).problems.map((p) => [p.kind, p.position]);
    expect(kinds).toEqual([['CHAIN_FORK', 2], ['RECORD_CONFLICT', 3]]);
  });

  it('flags an unsigned range and an over-long unsigned tail when asked', async () => {
    const m = chainOf(20);
    expect(await verifyChain(m, { keys })).toMatchObject({ ok: true });
    expect((await verifyChain(m, { keys, requireCheckpoint: true })).problems).toEqual([expect.objectContaining({ kind: 'UNSIGNED' })]);
    m.cps.push(signCheckpoint(signer, { upToPosition: 5, chainHash: m.entries[4]!.chainHash }));
    expect(await verifyChain(m, { keys, requireCheckpoint: true, maxUnsignedTail: 15 })).toMatchObject({ ok: true });
    expect((await verifyChain(m, { keys, requireCheckpoint: true, maxUnsignedTail: 10 })).problems).toEqual([expect.objectContaining({ kind: 'UNSIGNED', detail: expect.stringMatching(/^15 entries/) })]);
  });

  it('reports a gap in positions and stops at maxEntries (truncated)', async () => {
    const m = chainOf(10);
    m.entries.splice(4, 1);
    expect((await verifyChain(m, { keys })).problems[0]).toMatchObject({ kind: 'POSITION_GAP', position: 5 });
    const capped = await verifyChain(chainOf(10), { keys, maxEntries: 4 });
    expect(capped).toMatchObject({ ok: true, to: 4, truncated: true, entries: 4 });
  });
});
