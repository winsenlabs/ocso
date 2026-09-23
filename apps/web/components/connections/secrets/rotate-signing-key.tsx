'use client';

import { useState } from 'react';
import { rotateSigningKeyAction } from '@/lib/actions/secrets';
import { ConfirmAction } from '../confirm-action';

/** Rotates the customer-claims signing key; the previous key keeps verifying while it retires. */
export function RotateSigningKey() {
  const [kid, setKid] = useState<string | null>(null);
  return (
    <>
      {kid ? (
        <span className="mono-sm" role="status">
          new key {kid.slice(0, 12)}…
        </span>
      ) : null}
      <ConfirmAction
        label="Rotate key"
        buttonClass="btn tiny"
        title="Rotate the customer-claims signing key"
        confirmLabel="Rotate key"
        run={async () => {
          const r = await rotateSigningKeyAction();
          if (r.ok) setKid(r.data.kid);
          return r;
        }}
      >
        New claims are signed with a new key immediately. The current key moves to retiring and stays in the JWKS so tool servers can verify
        claims already issued.
      </ConfirmAction>
    </>
  );
}
