'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { authClient } from '@/lib/auth-client';

/** Registers a passkey in the browser (WebAuthn via Better Auth's client), then refreshes the list. */
export function AddPasskeyButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
      {error ? (
        <span className="mono-sm" role="alert" style={{ color: 'var(--danger)' }}>
          {error}
        </span>
      ) : null}
      <button
        type="button"
        className="btn tiny"
        disabled={busy}
        onClick={async () => {
          const name = window.prompt('Name this passkey (e.g. “Work laptop”)', '')?.trim();
          if (name === undefined) return;
          setBusy(true);
          setError(null);
          const result = await authClient.passkey.addPasskey(name ? { name } : {});
          setBusy(false);
          if (result?.error) setError(result.error.message ?? 'The passkey was not added.');
          else router.refresh();
        }}
      >
        {busy ? 'Waiting for your device…' : 'Add passkey'}
      </button>
    </span>
  );
}
