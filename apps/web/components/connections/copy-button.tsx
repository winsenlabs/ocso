'use client';

import { useState } from 'react';

/** Copies a value the admin must paste elsewhere (webhook URL, embed snippet, one-time secret). */
export function CopyButton({ value, label = 'Copy', what }: { value: string; label?: string; what: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  return (
    <button
      type="button"
      className="btn tiny"
      aria-label={`${label} ${what}`}
      onClick={() => {
        const done = navigator.clipboard?.writeText(value);
        if (!done) setState('failed');
        else void done.then(() => setState('copied'), () => setState('failed'));
      }}
    >
      {state === 'copied' ? 'Copied' : state === 'failed' ? 'Select and copy' : label}
    </button>
  );
}
