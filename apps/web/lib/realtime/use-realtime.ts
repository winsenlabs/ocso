'use client';

import { useEffect, useRef, useState } from 'react';
import { reconnectDelayMs } from './backoff';
import { isRealtimeEventType, type AnyRealtimeEvent, type RealtimeEventType } from './events';
import { SseParser } from './sse';

export type RealtimeStatus = 'connecting' | 'open' | 'retrying' | 'closed';

export interface UseRealtimeOptions {
  /** Only events for this conversation (filtered by the API). */
  conversationId?: string | undefined;
  /** Only these event types (filtered by the /api/realtime proxy). */
  types?: readonly RealtimeEventType[] | undefined;
  /** Default true; false closes the stream. */
  enabled?: boolean | undefined;
  onEvent: (event: AnyRealtimeEvent) => void;
  /**
   * Called when the stream (re)opens after a drop — events in the gap were
   * missed, so screens should refetch. Not called for the first connection.
   */
  onReconnect?: (() => void) | undefined;
}

/** Stream URL for the shared proxy (app/api/realtime/route.ts). */
export function realtimeUrl(conversationId?: string, types?: readonly string[]): string {
  const params = new URLSearchParams();
  if (conversationId) params.set('conversationId', conversationId);
  if (types?.length) params.set('types', types.join(','));
  const qs = params.toString();
  return qs ? `/api/realtime?${qs}` : '/api/realtime';
}

/**
 * Subscribe to the staff realtime stream (docs/14 §3) through the same-origin
 * proxy — the browser never holds the API token. Reconnects with exponential
 * backoff; stops for good on 401/403 (session over or no access).
 */
export function useRealtime({ conversationId, types, enabled = true, onEvent, onReconnect }: UseRealtimeOptions): RealtimeStatus {
  const [status, setStatus] = useState<RealtimeStatus>('connecting');
  const handlers = useRef({ onEvent, onReconnect });
  useEffect(() => {
    handlers.current = { onEvent, onReconnect };
  });
  const typeKey = types?.join(',') ?? '';

  useEffect(() => {
    if (!enabled) {
      setStatus('closed');
      return;
    }
    const abort = new AbortController();
    let attempt = 0;
    let everOpened = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const connect = async (): Promise<void> => {
      setStatus(attempt === 0 ? 'connecting' : 'retrying');
      let res: Response;
      try {
        res = await fetch(realtimeUrl(conversationId, typeKey ? typeKey.split(',') : undefined), {
          headers: { accept: 'text/event-stream' },
          cache: 'no-store',
          signal: abort.signal,
        });
      } catch {
        return retry();
      }
      if (res.status === 401 || res.status === 403) {
        setStatus('closed');
        return;
      }
      if (!res.ok || !res.body) return retry();

      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      const parser = new SseParser();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          for (const message of parser.push(value)) {
            if (message.event === 'ready') {
              setStatus('open');
              if (everOpened) handlers.current.onReconnect?.();
              everOpened = true;
              attempt = 0;
              continue;
            }
            if (!isRealtimeEventType(message.event)) continue;
            try {
              handlers.current.onEvent(JSON.parse(message.data) as AnyRealtimeEvent);
            } catch {
              // A malformed event or a throwing handler must not kill the stream.
            }
          }
        }
      } catch {
        // Stream dropped (network, API restart) or aborted.
      }
      return retry();
    };

    const retry = (): void => {
      if (abort.signal.aborted) return;
      setStatus('retrying');
      timer = setTimeout(() => void connect(), reconnectDelayMs(attempt++));
    };

    void connect();
    return () => {
      abort.abort();
      if (timer) clearTimeout(timer);
    };
  }, [conversationId, typeKey, enabled]);

  return status;
}
