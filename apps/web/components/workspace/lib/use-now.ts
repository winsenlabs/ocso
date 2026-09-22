'use client';

import { useEffect, useState } from 'react';

/**
 * Current time, re-rendering every `intervalMs` (SLA countdowns, "waiting
 * 2m 14s"). Pass the server's render time as `initial` so the first client
 * render matches the server HTML; the clock starts ticking after hydration.
 */
export function useNow(intervalMs = 1_000, initial?: number): number {
  const [now, setNow] = useState(() => initial ?? Date.now());
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
