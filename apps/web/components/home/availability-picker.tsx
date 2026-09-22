'use client';

import { useState, useTransition } from 'react';
import { setAvailabilityAction } from '@/lib/actions/me';

const OPTIONS = [
  { key: 'AVAILABLE', label: 'Available' },
  { key: 'AWAY', label: 'Away' },
  { key: 'OFFLINE', label: 'Offline' },
] as const;

/**
 * Sets the exec's availability for new assignments (PUT /v1/me/availability).
 * The API does not report the current value to the user yet, so nothing is
 * pre-selected until they choose.
 */
export function AvailabilityPicker() {
  const [value, setValue] = useState<string | null>(null);
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
      <span className="mono-sm" aria-live="polite">
        {pending ? 'saving…' : (message ?? 'not reported yet · choose to set')}
      </span>
    </div>
  );
}
