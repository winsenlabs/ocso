import { DomainError, ErrorCategory } from '@ocso/domain';

/**
 * In-process token buckets for the public web chat API (SPEC §C.5). Each API
 * instance limits on its own (v0.1: a deployment with N instances allows up to
 * N times the rate). Buckets refill continuously; idle buckets are dropped.
 */

export type WebChatLimit = 'sessionPassFailures' | 'session' | 'messages' | 'attachments' | 'stream';

/** Requests per minute. */
export const WEBCHAT_RATE_LIMITS: Readonly<Record<WebChatLimit, number>> = {
  sessionPassFailures: 30, // per channel + IP, wrong secret keys (successful mints are not limited: the caller holds the secret key)
  session: 30, // per channel + IP
  messages: 60, // per channel + visitor
  attachments: 20, // per channel + visitor
  stream: 30, // per channel + visitor
};

const WINDOW_MS = 60_000;
const MAX_BUCKETS = 50_000;

interface Bucket {
  tokens: number;
  at: number;
}

export class RateLimitedError extends DomainError {
  constructor(readonly retryAfterSeconds: number) {
    super(ErrorCategory.PROVIDER_RATE_LIMITED, 'rate_limited', 'Too many requests; try again shortly', { retryAfterSeconds });
  }
}

export class WebChatRateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly limits: Readonly<Record<WebChatLimit, number>> = WEBCHAT_RATE_LIMITS,
    private readonly now: () => number = Date.now,
  ) {}

  /** Take one token from `limit`'s bucket for `key`; throws RateLimitedError (429, Retry-After) when empty. */
  take(limit: WebChatLimit, key: string): void {
    const capacity = this.limits[limit];
    if (capacity <= 0) return; // turned off (OCSO_WEBCHAT_RATE_LIMITS)
    const perMs = capacity / WINDOW_MS;
    const now = this.now();
    const id = `${limit}\u0000${key}`;
    const current = this.buckets.get(id);
    const tokens = current ? Math.min(capacity, current.tokens + (now - current.at) * perMs) : capacity;
    if (tokens < 1) throw new RateLimitedError(Math.max(1, Math.ceil((1 - tokens) / perMs / 1000)));
    this.buckets.delete(id);
    this.buckets.set(id, { tokens: tokens - 1, at: now });
    if (this.buckets.size > MAX_BUCKETS) this.evict(now);
  }

  /** Drop full (idle) buckets; if still over the cap, the least recently used ones. */
  private evict(now: number): void {
    for (const [id, bucket] of this.buckets) if (now - bucket.at >= WINDOW_MS) this.buckets.delete(id);
    const excess = this.buckets.size - MAX_BUCKETS;
    if (excess <= 0) return;
    let dropped = 0;
    for (const id of this.buckets.keys()) {
      if (dropped++ >= excess) break;
      this.buckets.delete(id);
    }
  }
}
