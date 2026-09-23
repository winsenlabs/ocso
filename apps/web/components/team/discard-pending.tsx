'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { discardUserAction } from '@/lib/actions/team';

/**
 * Discard a user whose creation was never approved (DELETE /v1/users/:id): the
 * draft goes away and the email can be used again. Active users are disabled
 * instead, never deleted.
 */
export function DiscardPendingUser({ userId, name }: { userId: string; name: string }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const discard = () =>
    start(async () => {
      const result = await discardUserAction(userId);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      router.push('/team');
    });
  return (
    <span className="tm-perm-actions">
      {confirming ? (
        <>
          <span className="mono-sm">Discard {name}? This cannot be undone.</span>
          <button type="button" className="btn tiny danger" disabled={pending} onClick={discard}>
            {pending ? '…' : 'Discard user'}
          </button>
          <button type="button" className="btn tiny" disabled={pending} onClick={() => setConfirming(false)}>
            Keep
          </button>
        </>
      ) : (
        <button type="button" className="btn tiny" onClick={() => setConfirming(true)}>
          Discard
        </button>
      )}
      {error ? (
        <span className="mono-sm" role="alert">
          {error}
        </span>
      ) : null}
    </span>
  );
}
