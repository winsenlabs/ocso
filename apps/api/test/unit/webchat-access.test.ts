import { describe, expect, it } from 'vitest';
import { corsOriginAllowed, originDecision } from '../../src/modules/webchat/webchat-access.js';
import { RateLimitedError, WebChatRateLimiter } from '../../src/modules/webchat/webchat-rate-limit.js';

const OCSO = 'https://ocso.example.com';
const widget = (over: Partial<{ allowedOrigins: string[]; authMode: 'anonymous' | 'client' | 'user'; allowNativeApps: boolean }> = {}) => ({
  allowedOrigins: ['https://shop.example.com', 'https://*.shop.example.com'],
  authMode: 'anonymous' as const,
  allowNativeApps: false,
  ...over,
});

describe('who may call the public web chat API', () => {
  it('browser calls: OCSO itself, or an allowed site (an empty allowlist allows any)', () => {
    expect(originDecision(OCSO, OCSO, widget())).toBe('allowed');
    expect(originDecision('https://shop.example.com', OCSO, widget())).toBe('allowed');
    expect(originDecision('https://eu.shop.example.com', OCSO, widget())).toBe('allowed');
    expect(originDecision('https://evil.example.com', OCSO, widget())).toBe('not_allowed');
    expect(originDecision('https://evil.example.com', OCSO, widget({ allowedOrigins: [] }))).toBe('allowed');
  });

  it('no Origin (native apps, servers): only with native apps allowed or a non-anonymous auth mode', () => {
    expect(originDecision(undefined, OCSO, widget())).toBe('origin_required');
    expect(originDecision(undefined, OCSO, widget({ allowNativeApps: true }))).toBe('allowed');
    expect(originDecision(undefined, OCSO, widget({ authMode: 'client' }))).toBe('allowed');
    expect(originDecision(undefined, OCSO, widget({ authMode: 'user' }))).toBe('allowed');
  });

  it('CORS echoes allowed sites only, never the opaque null origin', () => {
    expect(corsOriginAllowed('https://shop.example.com', widget())).toBe(true);
    expect(corsOriginAllowed('https://evil.example.com', widget())).toBe(false);
    expect(corsOriginAllowed('https://evil.example.com', widget({ allowedOrigins: [] }))).toBe(true);
    expect(corsOriginAllowed('null', widget({ allowedOrigins: [] }))).toBe(false);
  });
});

describe('web chat rate limiter (token buckets)', () => {
  it('allows the per-minute budget, then 429 with Retry-After, and refills over time', () => {
    let now = 0;
    const limiter = new WebChatRateLimiter({ sessionPassFailures: 30, session: 3, messages: 60, attachments: 20, stream: 30 }, () => now);
    for (let i = 0; i < 3; i++) limiter.take('session', 'ch:1.2.3.4');
    let error: unknown;
    try {
      limiter.take('session', 'ch:1.2.3.4');
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(RateLimitedError);
    expect(error).toMatchObject({ code: 'rate_limited', category: 'provider_rate_limited', retryAfterSeconds: 20 });
    // Other keys and other limits have their own buckets.
    expect(() => limiter.take('session', 'ch:5.6.7.8')).not.toThrow();
    expect(() => limiter.take('messages', 'ch:1.2.3.4')).not.toThrow();
    now += 20_000;
    expect(() => limiter.take('session', 'ch:1.2.3.4')).not.toThrow();
    expect(() => limiter.take('session', 'ch:1.2.3.4')).toThrow(RateLimitedError);
  });
});
