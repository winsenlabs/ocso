import { describe, expect, it } from 'vitest';
import { MAX_TAGS, freshSuggestions, hrefWithTag, isValidTag, moveActive, normalizeTag, tagParam, withTag, withoutTag } from '../../../components/workspace/lib/tags';

describe('workspace tag rules', () => {
  it('normalizes like the API and validates the stored form', () => {
    expect(normalizeTag('  Duplicate   Debit ')).toBe('duplicate debit');
    expect(isValidTag('card_fee-waiver 2')).toBe(true);
    for (const bad of ['', '-x', 'x'.repeat(41), 'refund!', 'naïve']) expect(isValidTag(normalizeTag(bad)), bad).toBe(false);
  });

  it('adds a tag once, normalized, and refuses invalid tags or a 21st tag', () => {
    expect(withTag(['refund'], ' EMI ')).toEqual({ ok: true, tags: ['refund', 'emi'], changed: true });
    expect(withTag(['refund', 'emi'], 'Refund')).toEqual({ ok: true, tags: ['refund', 'emi'], changed: false });
    const bad = withTag([], '#vip');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.message).toMatch(/1–40 characters/);
    const full = Array.from({ length: MAX_TAGS }, (_, i) => `t${i}`);
    const over = withTag(full, 'one more');
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.message).toMatch(/at most 20 tags/);
    // An existing tag is still fine when the set is full.
    expect(withTag(full, 'T3')).toMatchObject({ ok: true, changed: false });
    expect(withoutTag(['a', 'b', 'c'], 'b')).toEqual(['a', 'c']);
  });

  it('reads ?tag= from the URL only when it is a valid tag', () => {
    expect(tagParam('Refund')).toBe('refund');
    expect(tagParam('%%')).toBeNull();
    expect(tagParam(null)).toBeNull();
    expect(tagParam('')).toBeNull();
  });

  it('builds inbox links that keep other params', () => {
    expect(hrefWithTag('/conversations/abc', 'view=waiting', 'duplicate debit')).toBe('/conversations/abc?view=waiting&tag=duplicate+debit');
    expect(hrefWithTag('/conversations', 'tag=emi&view=all', null)).toBe('/conversations?view=all');
    expect(hrefWithTag('/conversations', '', null)).toBe('/conversations');
  });

  it('suggests only tags not already present, most used first', () => {
    const items = [
      { tag: 'refund', count: 9 },
      { tag: 'emi', count: 4 },
      { tag: 'vip', count: 1 },
    ];
    expect(freshSuggestions(items, ['emi']).map((i) => i.tag)).toEqual(['refund', 'vip']);
    expect(freshSuggestions(items, [], 1)).toEqual([{ tag: 'refund', count: 9 }]);
  });

  it('moves through suggestions and wraps via the text box', () => {
    expect(moveActive(-1, 1, 3)).toBe(0);
    expect(moveActive(2, 1, 3)).toBe(-1);
    expect(moveActive(-1, -1, 3)).toBe(2);
    expect(moveActive(0, -1, 3)).toBe(-1);
    expect(moveActive(-1, 1, 0)).toBe(-1);
  });
});
