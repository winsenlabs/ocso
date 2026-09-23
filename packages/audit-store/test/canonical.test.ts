import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { GENESIS_HASH, canonicalJson, chainHash, recordHash } from '../src/canonical.js';
import { recordAt } from './support.js';

describe('canonical JSON', () => {
  it('sorts keys at every depth, keeps array order, drops undefined members, writes dates as ISO', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, 1, { z: 1, y: 2 }], c: undefined }, e: new Date('2026-09-23T10:00:00.123Z') })).toBe(
      '{"a":{"d":[3,1,{"y":2,"z":1}]},"b":1,"e":"2026-09-23T10:00:00.123Z"}',
    );
    expect(canonicalJson([undefined, null, 'x"y', true])).toBe('[null,null,"x\\"y",true]');
  });

  it('refuses values JSON cannot carry', () => {
    expect(() => canonicalJson({ n: Number.NaN })).toThrow(/non-finite/);
    expect(() => canonicalJson({ f: () => 1 })).toThrow(/unsupported/);
  });
});

describe('record and chain hashes', () => {
  it('hash the record, not its key order, and treat absent payloads as null', () => {
    const r = recordAt(new Date('2026-09-01T00:00:00.000Z'));
    const reordered = Object.fromEntries(Object.entries(r).reverse()) as typeof r;
    expect(recordHash(reordered)).toBe(recordHash(r));
    expect(recordHash({ ...r, confirmation: undefined })).toBe(recordHash({ ...r, confirmation: null }));
    expect(recordHash(r)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('change when any field changes', () => {
    const r = recordAt(new Date('2026-09-01T00:00:00.000Z'));
    const changed = [
      { summary: 'other' },
      { actorName: 'Mallory' },
      { occurredAt: new Date('2026-09-01T00:00:00.001Z') },
      { after: { name: 'Maya 3' } },
      { teamIds: ['0199aaaa-0000-7000-8000-000000000001'] },
      { ip: null },
    ];
    for (const patch of changed) expect(recordHash({ ...r, ...patch })).not.toBe(recordHash(r));
  });

  it('chain hash = sha256(prev ‖ record) over the hex strings; genesis is 64 zeros', () => {
    const rh = recordHash(recordAt(new Date()));
    expect(GENESIS_HASH).toBe('0'.repeat(64));
    expect(chainHash(GENESIS_HASH, rh)).toBe(createHash('sha256').update(`${GENESIS_HASH}${rh}`).digest('hex'));
  });
});
