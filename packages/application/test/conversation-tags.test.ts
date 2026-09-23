import { describe, expect, it } from 'vitest';
import { MAX_TAGS, ResolveInput, SetTagsInput, TAG_PATTERN, TagListSchema, TagSchema, describeTagChange, normalizeTag } from '../src/index.js';
import * as web from '../../../apps/web/components/workspace/lib/tags.js';

describe('conversation tag normalization', () => {
  it('trims, lowercases and collapses inner whitespace', () => {
    expect(normalizeTag('  Duplicate \t  Debit ')).toBe('duplicate debit');
    expect(TagSchema.parse('EMI')).toBe('emi');
    expect(TagSchema.parse('card_fee-waiver 2')).toBe('card_fee-waiver 2');
  });

  it('accepts 1–40 characters starting with a letter or digit', () => {
    expect(TagSchema.parse('a')).toBe('a');
    expect(TagSchema.parse('9'.repeat(40))).toHaveLength(40);
    for (const bad of ['', '   ', '-x', '_x', 'x'.repeat(41), 'refund!', 'naïve', 'a/b']) {
      expect(TagSchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('de-duplicates after normalizing and caps the set at 20', () => {
    expect(TagListSchema.parse(['Refund', ' refund ', 'EMI', 'emi'])).toEqual(['refund', 'emi']);
    const many = Array.from({ length: MAX_TAGS + 1 }, (_, i) => `t${i}`);
    expect(TagListSchema.safeParse(many).success).toBe(false);
    expect(TagListSchema.parse([...many.slice(0, MAX_TAGS), 'T0'])).toHaveLength(MAX_TAGS);
    expect(SetTagsInput.parse({ tags: [] })).toEqual({ tags: [] });
  });

  it('keeps resolve backwards compatible and normalizes optional tags', () => {
    expect(ResolveInput.parse({})).toEqual({});
    expect(ResolveInput.parse({ disposition: 'done', tags: ['VIP'] })).toEqual({ disposition: 'done', tags: ['vip'] });
    expect(ResolveInput.safeParse({ tags: ['?'] }).success).toBe(false);
  });

  it('describes a change as additions then removals', () => {
    expect(describeTagChange(['refund', 'emi'], ['refund', 'vip'])).toBe('+vip −emi');
    expect(describeTagChange(['a'], ['a'])).toBe('no change');
  });

  it('matches the rules the web workspace mirrors for optimistic edits', () => {
    expect(web.TAG_PATTERN.source).toBe(TAG_PATTERN.source);
    expect(web.MAX_TAGS).toBe(MAX_TAGS);
    for (const raw of ['  A  b ', 'EMI', 'x\ty', '-no', 'ok_1']) expect(web.normalizeTag(raw)).toBe(normalizeTag(raw));
  });
});
