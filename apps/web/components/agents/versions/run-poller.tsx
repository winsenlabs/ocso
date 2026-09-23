'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

/** Re-renders the page every few seconds while a replay evaluation is queued or running (the worker executes it). */
export function RunPoller({ active, intervalMs = 3_000 }: { active: boolean; intervalMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => router.refresh(), intervalMs);
    return () => window.clearInterval(timer);
  }, [active, intervalMs, router]);
  return active ? (
    <span className="mono-sm" role="status">
      refreshing while the replay runs…
    </span>
  ) : null;
}
