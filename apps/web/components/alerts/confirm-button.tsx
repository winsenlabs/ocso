'use client';

import { useState, useTransition, type ReactNode } from 'react';
import type { AlertActionResult } from '@/lib/actions/alerts';

/** Two-step destructive action: the first click asks, the second runs; errors stay inline. */
export function ConfirmButton({
  label,
  confirmLabel,
  children,
  run,
  onDone,
}: {
  label: string;
  confirmLabel: string;
  children: ReactNode;
  run: () => Promise<AlertActionResult>;
  onDone: () => void;
}) {
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  if (!asking) {
    return (
      <button type="button" className="btn danger" onClick={() => setAsking(true)}>
        {label}
      </button>
    );
  }
  return (
    <span role="group" aria-label={label} style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
      <span className="mono-sm" style={{ maxWidth: 260 }}>
        {error ?? children}
      </span>
      <button
        type="button"
        className="btn danger"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await run();
            if (r.ok) onDone();
            else setError(r.message);
          })
        }
      >
        {pending ? 'Working…' : confirmLabel}
      </button>
      <button type="button" className="btn ghost" onClick={() => setAsking(false)} disabled={pending}>
        Keep
      </button>
    </span>
  );
}
