'use client';

import { useState, useTransition } from 'react';
import { testDestinationAction } from '@/lib/actions/alerts';

/** Sends a synthetic alert through the destination now (POST …/:id/test) and shows the adapter's result. */
export function TestDestinationButton({ id, name }: { id: string; name: string }) {
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  return (
    <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <button
        type="button"
        className="btn tiny"
        disabled={pending}
        aria-label={`Send a test alert to ${name}`}
        onClick={() =>
          start(async () => {
            const r = await testDestinationAction(id);
            if (!r.ok) setResult({ ok: false, text: r.message });
            else setResult(r.data.ok ? { ok: true, text: 'test delivered' } : { ok: false, text: `test failed · ${r.data.error ?? 'unknown error'}` });
          })
        }
      >
        {pending ? 'Sending…' : 'Test'}
      </button>
      <span role="status" className="mono-sm" style={result && !result.ok ? { color: 'var(--danger)' } : undefined}>
        {result?.text ?? ''}
      </span>
    </span>
  );
}
