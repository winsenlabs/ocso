import { describe, expect, it } from 'vitest';
import { RateLimitedError, WEBCHAT_RATE_LIMITS, WebChatRateLimiter } from '../../src/modules/webchat/webchat-rate-limit.js';

describe('WebChatRateLimiter', () => {
  it('refuses the request after the per-minute capacity, then refills', () => {
    let now = 0;
    const limiter = new WebChatRateLimiter({ ...WEBCHAT_RATE_LIMITS, session: 2 }, () => now);
    limiter.take('session', 'ch|1.2.3.4');
    limiter.take('session', 'ch|1.2.3.4');
    expect(() => limiter.take('session', 'ch|1.2.3.4')).toThrow(RateLimitedError);
    limiter.take('session', 'ch|5.6.7.8'); // another address has its own bucket
    now += 30_000;
    limiter.take('session', 'ch|1.2.3.4');
  });

  it('a limit set to 0 is off (OCSO_WEBCHAT_RATE_LIMITS)', () => {
    const limiter = new WebChatRateLimiter({ ...WEBCHAT_RATE_LIMITS, session: 0 });
    for (let i = 0; i < 1_000; i++) limiter.take('session', 'office-nat');
  });
});
