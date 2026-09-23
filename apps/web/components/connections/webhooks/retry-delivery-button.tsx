'use client';

import { useState, useTransition } from 'react';
import { retryDeliveryAction } from '@/lib/actions/webhooks';

/** Re-queues a FAILED delivery (same event id; receivers dedupe on it). */
export function RetryDeliveryButton({ deliveryId }: { deliveryId: string }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <span>
      <button
        type="button"
        className="btn tiny"
        disabled={pending}
        title={error ?? undefined}
        onClick={() =>
          start(async () => {
            const r = await retryDeliveryAction(deliveryId);
            setError(r.ok ? null : r.message);
          })
        }
      >
        {pending ? '…' : 'Retry'}
      </button>
      {error ? (
        <span className="err-text" role="alert" style={{ display: 'block' }}>
          {error}
        </span>
      ) : null}
    </span>
  );
}
