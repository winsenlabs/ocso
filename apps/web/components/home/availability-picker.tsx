'use client';

import { useState, useTransition } from 'react';
import { setAvailabilityAction } from '@/lib/actions/me';

const OPTIONS = [
  { key: 'AVAILABLE', label: 'Available' },
  { key: 'AWAY', label: 'Away' },
  { key: 'OFFLINE', label: 'Offline' },
] as const;

/** The exec's availability for new assignments: current value from GET /v1/home, changed via PUT /v1/me/availability. */
export function AvailabilityPicker({ initial }: { initial: string }) {
  const [value, setValue] = useState<string>(initial);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function choose(key: string) {
    startTransition(async () => {
      const result = await setAvailabilityAction(key);
      if (result.ok) {
        setValue(result.availability);
        setMessage('saved');
      } else {
        setMessage(result.message);
      }
    });
  }

  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <div role="group" aria-label="Availability" style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
        {OPTIONS.map((o) => (
          <button
            key={o.key}
            type="button"
            className={value === o.key ? 'fchip active' : 'fchip'}
            style={{ fontSize: 11, padding: '3px 9px' }}
            aria-pressed={value === o.key}
            disabled={pending}
            onClick={() => choose(o.key)}
          >
            {o.label}
          </button>
        ))}
      </div>
      {pending || message ? (
        <span className="mono-sm" aria-live="polite">
          {pending ? 'saving…' : message}
        </span>
      ) : null}
    </div>
  );
}
