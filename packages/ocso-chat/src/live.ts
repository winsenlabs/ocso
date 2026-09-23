import { ChatApiError, errorFrom, type ChatApi } from './api.js';
import { isOffline, newAbortController, onOnline, timers, type AbortControllerLike } from './platform.js';
import { backoffDelay, createSseParser, createUtf8Decoder, DEFAULT_BACKOFF, type BackoffOptions } from './sse.js';
import type { StreamReaderLike } from './types.js';
import { parseLiveEvent, type LiveEvent } from './wire.js';

/**
 * Live transports. `SseConnection` streams `GET /stream` (fetch-based SSE with
 * reconnect + backoff, a silence watchdog — the API pings every 20 s — and
 * offline awareness; every successful connect emits `ready`, on which the
 * client gap-fills history). `PollConnection` re-reads history on an interval
 * for platforms that cannot read a response body incrementally.
 */

export type LiveStatus = 'connecting' | 'open' | 'reconnecting' | 'offline' | 'stopped';

export interface LiveState {
  status: LiveStatus;
  attempt: number;
  retryAt: number | null;
}

export interface LiveTransport {
  readonly kind: 'sse' | 'poll';
  start(): void;
  stop(): void;
  reconnectNow(): void;
}

interface Common {
  onState: (state: LiveState) => void;
  /** 401: renew the visitor token before the next attempt. */
  onUnauthorized: () => Promise<void>;
  /**
   * A failure retrying cannot fix (403 origin refused, 404 unknown key, a
   * session pass or user token the host cannot supply, a token the stream keeps
   * refusing). The loop has stopped; the caller surfaces the error.
   */
  onFatal: (error: ChatApiError) => void;
  backoff?: BackoffOptions | undefined;
}

/** 4xx other than 401 (renewable), 408 and 429 (transient): retrying will not help. */
export function isTerminal(err: unknown): boolean {
  return err instanceof ChatApiError && err.status >= 400 && err.status < 500 && err.status !== 401 && err.status !== 408 && err.status !== 429;
}

/** Consecutive 401s (each followed by a successful renewal) before giving up. */
const MAX_UNAUTHORIZED = 3;

interface Attempt {
  unauthorized?: boolean;
  delayMs?: number;
  failed?: boolean;
  retryAfterMs?: number | null;
  /** The server's error for this attempt, when it sent one. */
  error?: ChatApiError;
}

abstract class Loop implements LiveTransport {
  abstract readonly kind: 'sse' | 'poll';
  protected stopped = true;
  protected attempt = 0;
  /** Consecutive 401s; reset once the transport is open. */
  protected unauthorizedStreak = 0;
  private wake: (() => void) | null = null;
  private offOnline: (() => void) | null = null;

  constructor(protected readonly common: Common) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.offOnline = onOnline(() => this.reconnectNow());
    void this.loop();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.offOnline?.();
    this.interrupt();
    this.wake?.();
    this.emit('stopped', null);
  }

  reconnectNow(): void {
    if (this.stopped) return;
    if (this.wake) this.wake();
    else this.interrupt();
  }

  /** Abort the in-flight attempt (if any). */
  protected interrupt(): void {}

  protected emit(status: LiveStatus, retryAt: number | null): void {
    if (status === 'open') this.unauthorizedStreak = 0;
    this.common.onState({ status, attempt: this.attempt, retryAt });
  }

  private fatal(error: ChatApiError): void {
    // Report first so the owner can detach before the `stopped` state arrives.
    this.common.onFatal(error);
    this.stop();
  }

  /** One attempt. `unauthorized` → renew the token; `delay` → wait this long (success path of polling). */
  protected abstract once(): Promise<Attempt>;

  private async loop(): Promise<void> {
    while (!this.stopped) {
      if (isOffline()) {
        this.emit('offline', null);
        await this.sleep(5_000);
        continue;
      }
      if (this.attempt > 0 || this.kind === 'sse') this.emit(this.attempt === 0 ? 'connecting' : 'reconnecting', null);
      const result = await this.once();
      if (this.stopped) return;
      if (result.error && isTerminal(result.error)) return this.fatal(result.error);
      if (result.unauthorized) {
        this.unauthorizedStreak += 1;
        if (this.unauthorizedStreak > MAX_UNAUTHORIZED) return this.fatal(result.error ?? new ChatApiError(401, 'webchat_token_invalid', 'The chat session was refused'));
        const renewal = await this.common.onUnauthorized().then(
          () => null,
          (err: unknown) => err,
        );
        if (this.stopped) return;
        // The renewal itself was refused for good (no/invalid session pass or user token, origin refused…).
        if (renewal instanceof ChatApiError && (isTerminal(renewal) || renewal.status === 401)) return this.fatal(renewal);
      }
      if (result.delayMs !== undefined && !result.failed) {
        await this.sleep(result.delayMs);
        continue;
      }
      this.attempt += 1;
      const delay = Math.max(result.retryAfterMs ?? 0, backoffDelay(this.attempt, this.common.backoff ?? DEFAULT_BACKOFF));
      this.emit('reconnecting', Date.now() + delay);
      await this.sleep(delay);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        timers.clear(timer);
        if (this.wake === done) this.wake = null;
        resolve();
      };
      const timer = timers.set(done, ms);
      this.wake = done;
    });
  }
}

export interface SseOptions extends Common {
  api: ChatApi;
  token: () => string | null;
  onEvent: (event: LiveEvent) => void;
  /** The platform cannot read the body as a stream (e.g. React Native fetch): switch to polling. */
  onUnsupported: () => void;
  silenceMs?: number | undefined;
}

export class SseConnection extends Loop {
  readonly kind = 'sse' as const;
  private request: AbortControllerLike | null = null;

  constructor(private readonly options: SseOptions) {
    super(options);
  }

  protected override interrupt(): void {
    this.request?.abort();
  }

  protected async once() {
    const controller = newAbortController();
    this.request = controller;
    const silenceMs = this.options.silenceMs ?? 45_000;
    let watchdog: unknown = null;
    let reader: StreamReaderLike | null = null;
    const feed = () => {
      timers.clear(watchdog);
      watchdog = timers.set(() => controller.abort(), silenceMs);
    };
    try {
      const token = this.options.token();
      if (!token) return { unauthorized: true };
      feed();
      const res = await this.options.api.stream(token, controller.signal);
      if (!res.ok) {
        const error = await errorFrom(res).catch(() => new ChatApiError(res.status, `http_${res.status}`, 'Request failed'));
        if (res.status === 401) return { unauthorized: true, error };
        return { failed: true, error, retryAfterMs: res.status === 429 ? retryAfterOf(res.headers.get('retry-after')) : null };
      }
      if (!res.body || typeof res.body.getReader !== 'function') {
        this.options.onUnsupported();
        return {};
      }
      reader = res.body.getReader();
      const decoder = createUtf8Decoder();
      const parser = createSseParser((message) => {
        let data: unknown;
        try {
          data = message.data ? JSON.parse(message.data) : {};
        } catch {
          return;
        }
        const event = parseLiveEvent(message.event, data);
        if (!event) return;
        if (event.event === 'ready') {
          this.attempt = 0;
          this.emit('open', null);
        }
        this.options.onEvent(event);
      });
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        feed();
        if (value !== undefined) parser.push(decoder.decode(value));
      }
      parser.end();
      return {};
    } catch (err) {
      if (err instanceof ChatApiError && err.status === 401) return { unauthorized: true, error: err };
      return {};
    } finally {
      timers.clear(watchdog);
      controller.abort();
      reader?.cancel?.().catch(() => undefined);
      if (this.request === controller) this.request = null;
    }
  }
}

export interface PollOptions extends Common {
  /** Fetch what is new (history after the last seen seq). */
  poll: () => Promise<void>;
  intervalMs: number;
}

export class PollConnection extends Loop {
  readonly kind = 'poll' as const;
  private opened = false;

  constructor(private readonly options: PollOptions) {
    super(options);
  }

  override start(): void {
    this.opened = false;
    super.start();
  }

  protected async once() {
    try {
      await this.options.poll();
      if (!this.opened || this.attempt > 0) {
        this.opened = true;
        this.attempt = 0;
        this.emit('open', null);
      }
      return { delayMs: this.options.intervalMs };
    } catch (err) {
      if (err instanceof ChatApiError && err.status === 401) return { unauthorized: true, error: err };
      if (err instanceof ChatApiError) return { failed: true, error: err, retryAfterMs: err.status === 429 ? err.retryAfterMs : null };
      return { failed: true };
    }
  }
}

function retryAfterOf(raw: string | null): number | null {
  if (!raw) return null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) ? seconds * 1000 : null;
}
