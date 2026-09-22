'use client';

import { useState, useTransition } from 'react';
import { setAlertRuleEnabledAction } from '@/lib/actions/alerts';

/** Inline enable/disable for a rule (PATCH /v1/alert-rules/:id { enabled }). */
export function RuleEnabledToggle({ id, name, enabled }: { id: string; name: string; enabled: boolean }) {
  const [on, setOn] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <label className="toggle-row" title={error ?? undefined}>
      <input
        type="checkbox"
        checked={on}
        disabled={pending}
        aria-label={`${name} enabled`}
        onChange={(e) => {
          const next = e.target.checked;
          setOn(next);
          setError(null);
          start(async () => {
            const r = await setAlertRuleEnabledAction(id, next);
            if (!r.ok) {
              setOn(!next);
              setError(r.message);
            }
          });
        }}
      />
      <span className="mono-sm">{error ? 'failed' : on ? 'on' : 'off'}</span>
    </label>
  );
}
