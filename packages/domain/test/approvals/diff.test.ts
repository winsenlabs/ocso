import { describe, expect, it } from 'vitest';
import { DIFF_MAX_DEPTH, DIFF_MAX_FIELDS, describeDiff, diffFields, humanize } from '../../src/index.js';

describe('diffFields', () => {
  it('reports added, removed and changed fields with dotted paths', () => {
    const before = { name: 'Maya', purpose: 'cards', hours: { timezone: 'UTC', days: 5 }, gone: 'x' };
    const after = { name: 'Maya', purpose: 'cards & EMI', hours: { timezone: 'Asia/Kolkata', days: 5 }, added: true };
    expect(diffFields(before, after)).toEqual([
      { path: 'added', before: null, after: true, change: 'added' },
      { path: 'gone', before: 'x', after: null, change: 'removed' },
      { path: 'hours.timezone', before: 'UTC', after: 'Asia/Kolkata', change: 'changed' },
      { path: 'purpose', before: 'cards', after: 'cards & EMI', change: 'changed' },
    ]);
  });

  it('compares arrays whole and treats null and missing alike', () => {
    expect(diffFields({ channels: ['a', 'b'], x: null }, { channels: ['a', 'c'] })).toEqual([{ path: 'channels', before: ['a', 'b'], after: ['a', 'c'], change: 'changed' }]);
    expect(diffFields({ channels: ['a'] }, { channels: ['a'] })).toEqual([]);
  });

  it('lists every field of a created or deleted object', () => {
    expect(diffFields(null, { b: 2, a: 1 })).toEqual([
      { path: 'a', before: null, after: 1, change: 'added' },
      { path: 'b', before: null, after: 2, change: 'added' },
    ]);
    expect(diffFields({ a: 1 }, null)).toEqual([{ path: 'a', before: 1, after: null, change: 'removed' }]);
  });

  it('caps depth (deeper objects compared whole) and the number of fields', () => {
    let deep: Record<string, unknown> = { v: 1 };
    let deeper: Record<string, unknown> = { v: 2 };
    for (let i = 0; i < DIFF_MAX_DEPTH + 2; i++) {
      deep = { n: deep };
      deeper = { n: deeper };
    }
    const [field] = diffFields(deep, deeper);
    expect(field!.path.split('.')).toHaveLength(DIFF_MAX_DEPTH);
    const wide = (v: number) => Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`k${String(i).padStart(3, '0')}`, v]));
    expect(diffFields(wide(1), wide(2))).toHaveLength(DIFF_MAX_FIELDS);
  });

  it('is deterministic for equal inputs whatever the key order', () => {
    const a = diffFields({ b: 1, a: { y: 1, x: 2 } }, { a: { x: 3, y: 1 }, b: 2 });
    const b = diffFields({ a: { x: 2, y: 1 }, b: 1 }, { b: 2, a: { y: 1, x: 3 } });
    expect(a).toEqual(b);
    expect(diffFields({ a: { x: 1, y: 2 } }, { a: { y: 2, x: 1 } })).toEqual([]);
  });

  it('normalizes dates to ISO strings', () => {
    const d = new Date('2026-09-23T00:00:00Z');
    expect(diffFields({ at: d }, { at: '2026-09-23T00:00:00.000Z' })).toEqual([]);
  });
});

describe('describeDiff', () => {
  it('names the changed top-level fields in plain words', () => {
    expect(describeDiff(diffFields({ name: 'a', modelProfileId: 'x', businessHours: { tz: 'a' } }, { name: 'b', modelProfileId: 'y', businessHours: { tz: 'b' } }))).toBe(
      'business hours, model profile, name',
    );
    expect(describeDiff([])).toBe('no changes');
    const many = diffFields(Object.fromEntries('abcdefgh'.split('').map((k) => [k, 1])), Object.fromEntries('abcdefgh'.split('').map((k) => [k, 2])));
    expect(describeDiff(many)).toBe('a, b, c, d, e and 3 more');
  });

  it('humanizes keys', () => {
    expect(humanize('channelIds')).toBe('channels');
    expect(humanize('max_tool_steps')).toBe('max tool steps');
    expect(humanize('defaultQueueId')).toBe('default queue');
  });
});
