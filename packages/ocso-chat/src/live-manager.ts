import type { ChatApi, ChatApiError } from './api.js';
import { canStreamResponses } from './platform.js';
import { PollConnection, SseConnection, type LiveStatus, type LiveTransport } from './live.js';
import type { TransportPreference } from './types.js';
import type { LiveEvent } from './wire.js';

export interface LiveManagerOptions {
  api: ChatApi;
  preference: TransportPreference;
  pollIntervalMs: number;
  token: () => string | null;
  onUnauthorized: () => Promise<void>;
  /** The transport stopped on an error retrying cannot fix. */
  onFatal: (error: ChatApiError) => void;
  onEvent: (event: LiveEvent) => void;
  /** Polling: fetch what is new. */
  poll: () => Promise<void>;
  /** Status or transport changed. */
  onChange: () => void;
}

/**
 * Owns the live transport: SSE (or polling when asked). `auto` polls from the
 * start on platforms whose fetch cannot stream (React Native), and switches to
 * polling for good if a response arrives without a readable body.
 */
export class LiveManager {
  private current: LiveTransport | null = null;
  status: LiveStatus = 'stopped';

  constructor(private readonly options: LiveManagerOptions) {}

  get kind(): 'sse' | 'poll' | null {
    return this.current?.kind ?? null;
  }

  start(): void {
    this.current?.stop();
    const poll = this.options.preference === 'poll' || (this.options.preference === 'auto' && !canStreamResponses());
    this.current = poll ? this.poll() : this.sse();
    this.status = 'connecting';
    this.current.start();
  }

  stop(): void {
    this.current?.stop();
    this.current = null;
    this.status = 'stopped';
  }

  reconnectNow(): void {
    this.current?.reconnectNow();
  }

  private common(self: () => LiveTransport) {
    return {
      onState: (state: { status: LiveStatus }) => {
        if (this.current !== self() || this.status === state.status) return;
        this.status = state.status;
        this.options.onChange();
      },
      onUnauthorized: this.options.onUnauthorized,
      onFatal: (error: ChatApiError) => {
        if (this.current !== self()) return;
        this.current = null;
        this.status = 'stopped';
        this.options.onFatal(error);
      },
    };
  }

  private poll(): LiveTransport {
    const t: LiveTransport = new PollConnection({ ...this.common(() => t), poll: this.options.poll, intervalMs: this.options.pollIntervalMs });
    return t;
  }

  private sse(): LiveTransport {
    const t: LiveTransport = new SseConnection({
      ...this.common(() => t),
      api: this.options.api,
      token: this.options.token,
      onEvent: this.options.onEvent,
      onUnsupported: () => {
        if (this.current !== t) return;
        this.current = this.poll();
        t.stop();
        this.status = 'connecting';
        this.current.start();
        this.options.onChange();
      },
    });
    return t;
  }
}
