import { backoffDelay, createSseParser, DEFAULT_BACKOFF, type BackoffOptions } from './sse';
import { LiveEvent } from './types';

/**
 * The visitor's live connection to `GET /public/webchat/:key/stream`, with
 * reconnect + exponential backoff, a silence watchdog (the API pings every
 * 20 s) and offline awareness. Every successful (re)connect emits `ready`, on
 * which the widget gap-fills history so nothing sent while disconnected is
 * lost.
 */

export type LiveStatus = 'connecting' | 'open' | 'reconnecting' | 'offline' | 'stopped';

export interface LiveState {
  status: LiveStatus;
  attempt: number;
  /** When the next reconnect attempt is due (ms epoch), while reconnecting. */
  retryAt: number | null;
}

export interface LiveOptions {
  url: string;
  token: () => string | null;
  /** Called on 401: renew the visitor token before the next attempt. */
  onUnauthorized: () => Promise<void>;
  onEvent: (event: LiveEvent) => void;
  onState: (state: LiveState) => void;
  fetchImpl?: typeof fetch;
  backoff?: BackoffOptions;
  /** Reconnect when nothing (not even a ping) arrived for this long. */
  silenceMs?: number;
}

class StaleStreamError extends Error {}

export class LiveConnection {
  private stopped = true;
  private attempt = 0;
  private request: AbortController | null = null;
  private wake: (() => void) | null = null;
  private readonly onOnline = () => this.reconnectNow();

  constructor(private readonly options: LiveOptions) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    if (typeof window !== 'undefined') window.addEventListener('online', this.onOnline);
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
    if (typeof window !== 'undefined') window.removeEventListener('online', this.onOnline);
    this.request?.abort();
    this.wake?.();
    this.emit('stopped', null);
  }

  /** Skip the backoff wait (or drop a silent stream) and connect now. */
  reconnectNow(): void {
    if (this.stopped) return;
    if (this.wake) this.wake();
    else this.request?.abort(new StaleStreamError('reconnect requested'));
  }

  private emit(status: LiveStatus, retryAt: number | null): void {
    this.options.onState({ status, attempt: this.attempt, retryAt });
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        this.emit('offline', null);
        await this.sleep(null);
        continue;
      }
      this.emit(this.attempt === 0 ? 'connecting' : 'reconnecting', null);
      const unauthorized = await this.connectOnce();
      if (this.stopped) return;
      if (unauthorized) {
        await this.options.onUnauthorized().catch(() => undefined);
      }
      this.attempt += 1;
      const delay = backoffDelay(this.attempt, this.options.backoff ?? DEFAULT_BACKOFF);
      this.emit('reconnecting', Date.now() + delay);
      await this.sleep(delay);
    }
  }

  /** One connection attempt; resolves when the stream ends. Returns true on 401. */
  private async connectOnce(): Promise<boolean> {
    const controller = new AbortController();
    this.request = controller;
    const silenceMs = this.options.silenceMs ?? 45_000;
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    const feed = () => {
      if (watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(() => controller.abort(new StaleStreamError('stream went silent')), silenceMs);
    };
    try {
      const token = this.options.token();
      if (!token) return true;
      feed();
      const res = await (this.options.fetchImpl ?? fetch)(this.options.url, {
        headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' },
        cache: 'no-store',
        credentials: 'omit',
        signal: controller.signal,
      });
      if (res.status === 401) return true;
      if (!res.ok || !res.body) return false;
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      const parser = createSseParser((message) => {
        let data: unknown;
        try {
          data = message.data ? JSON.parse(message.data) : {};
        } catch {
          return;
        }
        const parsed = LiveEvent.safeParse({ event: message.event, data });
        if (!parsed.success) return;
        if (parsed.data.event === 'ready') {
          this.attempt = 0;
          this.emit('open', null);
        }
        this.options.onEvent(parsed.data);
      });
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        feed();
        parser.push(value);
      }
      parser.end();
      return false;
    } catch {
      return false;
    } finally {
      if (watchdog) clearTimeout(watchdog);
      controller.abort();
      if (this.request === controller) this.request = null;
    }
  }

  /** Wait `ms` (or until woken when null); `reconnectNow`/`stop` wake it early. */
  private sleep(ms: number | null): Promise<void> {
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const done = () => {
        if (timer) clearTimeout(timer);
        if (this.wake === done) this.wake = null;
        resolve();
      };
      this.wake = done;
      if (ms !== null) timer = setTimeout(done, ms);
    });
  }
}
