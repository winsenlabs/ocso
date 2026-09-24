'use client';

import { useState, useTransition } from 'react';
import { revokeChatLinkAction } from '@/lib/actions/chat-links';

/** Revoke one chat account link (after a confirm); the row disappears on refresh. */
export function RevokeChatLink({ id, label }: { id: string; label: string }) {
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
        aria-label={`Revoke ${label}`}
        onClick={() => {
          if (!window.confirm(`Revoke the link of ${label}? Ask OCSO stops answering that chat account at once.`)) return;
          start(async () => {
            const result = await revokeChatLinkAction(id);
            setMessage(result.ok ? null : result.message);
          });
        }}
      >
        {pending ? '…' : 'Revoke'}
      </button>
    </span>
  );
}
