'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { RealtimeEventType } from '@/lib/realtime/events';
import { useRealtime } from '@/lib/realtime/use-realtime';

export interface LiveRefreshProps {
  /** Realtime events that make the page stale (payloads carry ids only → the server re-reads). */
  events?: readonly RealtimeEventType[];
  /**
   * Poll for figures that have no event (worker heartbeats, queue depth,
   * telemetry): re-render the server components every `pollSeconds` while the
   * tab is visible. Omit to rely on events alone.
   */
  pollSeconds?: number;
}

/**
 * Keeps a server-rendered screen current: realtime events (via the shared
 * /api/realtime proxy) and an optional modest poll both call router.refresh(),
 * debounced so bursts collapse into one re-read.
 */
export function LiveRefresh({ events = [], pollSeconds }: LiveRefreshProps) {
  const router = useRouter();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

  const schedule = useCallback(() => {
    if (timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      router.refresh();
      setUpdatedAt(new Date());
    }, 400);
  }, [router]);

  const live = useRealtime({ types: events, enabled: events.length > 0, onEvent: schedule, onReconnect: schedule });

  useEffect(() => {
    if (!pollSeconds) return;
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') schedule();
    }, pollSeconds * 1000);
    return () => clearInterval(id);
  }, [pollSeconds, schedule]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const parts = [
    events.length ? (live === 'open' ? 'live' : live === 'closed' ? 'live updates off' : 'connecting') : null,
    pollSeconds ? `refreshes every ${pollSeconds}s` : null,
    updatedAt ? `updated ${updatedAt.toLocaleTimeString('en-GB', { hour12: false })}` : null,
  ].filter(Boolean);
  return (
    <span className="mono-sm" aria-live="off" data-live={live}>
      {parts.join(' · ')}
    </span>
  );
}
