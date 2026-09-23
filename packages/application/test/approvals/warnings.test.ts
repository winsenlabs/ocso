import { describe, expect, it } from 'vitest';
import { dependencyHashOf, dependencyKeysOf, dependencyOf, proposalContentHash, warningsFrom, type WarningFacts } from '../../src/approvals/index.js';

const clean: WarningFacts = {
  objectExists: true,
  liveContentHash: 'ap_a',
  storedContentHash: 'ap_a',
  liveDependencyHash: 'ad_a',
  storedDependencyHash: 'ad_a',
  editedAfterSubmission: false,
  problems: [],
  checkerValid: true,
  selfReview: false,
  ageHours: 1,
  ageThresholdHours: 72,
};
const codes = (f: Partial<WarningFacts>) => warningsFrom({ ...clean, ...f }).map((w) => w.code);

describe('approval warnings', () => {
  it('raises nothing for a clean proposal', () => {
    expect(warningsFrom(clean)).toEqual([]);
  });

  it('raises each code from its fact', () => {
    expect(codes({ liveContentHash: 'ap_b' })).toEqual(['content_changed']);
    expect(codes({ liveDependencyHash: 'ad_b' })).toEqual(['dependency_changed']);
    expect(codes({ editedAfterSubmission: true })).toEqual(['edited_after_submission']);
    expect(codes({ problems: [{ code: 'x', message: 'Broken.' }] })).toEqual(['validation_failed']);
    expect(codes({ checkerValid: false })).toEqual(['checker_invalid']);
    expect(codes({ selfReview: true })).toEqual(['self_review']);
    expect(codes({ objectExists: false, liveContentHash: 'ap_b' })).toEqual(['object_missing']);
    expect(codes({ ageHours: 80 })).toEqual(['aged']);
  });

  it('every warning but age blocks bulk approval', () => {
    const all = warningsFrom({ ...clean, liveDependencyHash: 'x', editedAfterSubmission: true, problems: [{ code: 'p', message: 'm' }], checkerValid: false, selfReview: true, ageHours: 100, liveContentHash: 'y' });
    expect(all.filter((w) => !w.blocksBulk).map((w) => w.code)).toEqual(['aged']);
    expect(warningsFrom({ ...clean, problems: [{ code: 'p', message: 'Provider disabled.' }] })[0]!.message).toBe('Provider disabled.');
  });
});

describe('approval hashes', () => {
  const base = { objectKind: 'agent', objectId: 'a', action: 'UPDATE' as const, revision: 1, payload: { b: 1, a: 2 }, beforeSnapshot: { status: 'LIVE', name: 'Maya' } };

  it('content hash: order-insensitive, sensitive to payload, revision and before', () => {
    expect(proposalContentHash(base)).toBe(proposalContentHash({ ...base, payload: { a: 2, b: 1 } }));
    expect(proposalContentHash(base)).not.toBe(proposalContentHash({ ...base, revision: 2 }));
    expect(proposalContentHash(base)).not.toBe(proposalContentHash({ ...base, payload: { a: 3, b: 1 } }));
    expect(proposalContentHash(base)).not.toBe(proposalContentHash({ ...base, beforeSnapshot: { status: 'LIVE', name: 'Maya 2' } }));
    expect(proposalContentHash(base)).toMatch(/^ap_/);
  });

  it('excluded keys (a stop action’s state) do not change the content hash', () => {
    const paused = { ...base, beforeSnapshot: { status: 'PAUSED', name: 'Maya' } };
    expect(proposalContentHash(base, ['status'])).toBe(proposalContentHash(paused, ['status']));
    expect(proposalContentHash(base)).not.toBe(proposalContentHash(paused));
  });

  it('dependency hash and keys ignore order', () => {
    const at = new Date('2026-09-23T00:00:00Z');
    const deps = [dependencyOf('queue', 'q1', at), dependencyOf('model_profile', 'p1', null)];
    expect(deps[1]).toBe('model_profile:p1@missing');
    expect(dependencyHashOf(deps)).toBe(dependencyHashOf([...deps].reverse()));
    expect(dependencyKeysOf(deps)).toEqual(['model_profile:p1', 'queue:q1']);
  });
});
