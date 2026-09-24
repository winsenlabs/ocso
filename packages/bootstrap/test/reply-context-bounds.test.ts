import { boundedReplyContext, REPLY_CONTEXT_MAX_BYTES as CORE_MAX_BYTES, REPLY_CONTEXT_MAX_KEYS as CORE_MAX_KEYS } from '@ocso/application';
import { REPLY_CONTEXT_MAX_BYTES, REPLY_CONTEXT_MAX_KEYS } from '@ocso/channels';
import { describe, expect, it } from 'vitest';

/** Ingress stores an adapter's reply context only within the bounds the channel contract publishes. */
describe('reply context bounds', () => {
  it('core stores within the limits the channel contract documents', () => {
    expect(CORE_MAX_KEYS).toBe(REPLY_CONTEXT_MAX_KEYS);
    expect(CORE_MAX_BYTES).toBe(REPLY_CONTEXT_MAX_BYTES);
  });

  it('keeps a small string context as is', () => {
    expect(boundedReplyContext({ channel: 'C1', threadTs: '1.2' })).toEqual({ channel: 'C1', threadTs: '1.2' });
  });

  it('drops absent, empty, non-string, too many keys and too large contexts', () => {
    expect(boundedReplyContext(undefined)).toBeNull();
    expect(boundedReplyContext({})).toBeNull();
    expect(boundedReplyContext({ a: 1 } as never)).toBeNull();
    expect(boundedReplyContext({ a: { b: 'c' } } as never)).toBeNull();
    expect(boundedReplyContext(Object.fromEntries(Array.from({ length: REPLY_CONTEXT_MAX_KEYS + 1 }, (_, i) => [`k${i}`, 'v'])))).toBeNull();
    expect(boundedReplyContext(Object.fromEntries(Array.from({ length: REPLY_CONTEXT_MAX_KEYS }, (_, i) => [`k${i}`, 'v'])))).not.toBeNull();
    expect(boundedReplyContext({ big: 'x'.repeat(REPLY_CONTEXT_MAX_BYTES) })).toBeNull();
  });
});
