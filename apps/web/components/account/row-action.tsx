'use client';

import { useState, useTransition } from 'react';
import { deletePasskeyAction, revokeOtherSessionsAction, revokeSessionAction, type ActionResult } from '@/lib/actions/account';

const RUN: Record<'passkey' | 'session' | 'others', (id: string) => Promise<ActionResult>> = {
  passkey: deletePasskeyAction,
  session: revokeSessionAction,
  others: () => revokeOtherSessionsAction(),
};

/** A single-click account action (remove passkey, sign out a session) with inline result. */
export function RowAction({ kind, id, label, ariaLabel, confirm }: { kind: 'passkey' | 'session' | 'others'; id: string; label: string; ariaLabel?: string; confirm?: string }) {
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  return (
    <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
      {message ? (
        <span className="mono-sm" role="status">
          {message}
        </span>
      ) : null}
      <button
        type="button"
        className="btn tiny"
        disabled={pending}
        aria-label={ariaLabel}
        onClick={() => {
          if (confirm && !window.confirm(confirm)) return;
          start(async () => {
            const result = await RUN[kind](id);
            setMessage(result.ok ? null : result.message);
          });
        }}
      >
        {pending ? '…' : label}
      </button>
    </span>
  );
}
