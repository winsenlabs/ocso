import { SecHead } from '@/components/ui/sec-head';
import type { PasskeyRow } from '@/lib/api/account';
import { formatDateTime } from '@/lib/format';
import { AddPasskeyButton } from './add-passkey-button';
import { RowAction } from './row-action';

/** Passkeys (WebAuthn): sign in without a password; they count as two factors. */
export function PasskeysCard({ passkeys, timeZone }: { passkeys: PasskeyRow[]; timeZone: string }) {
  return (
    <section className="ch sec-card" aria-label="Passkeys">
      <SecHead title="Passkeys" count={passkeys.length} actions={<AddPasskeyButton />} />
      {passkeys.length ? (
        <div>
          {passkeys.map((p) => (
            <div className="sec-row" key={p.id}>
              <div className="sec-main">
                <b>{p.name || 'Passkey'}</b>
                <span className="mono-sm">
                  {p.deviceType === 'multiDevice' ? 'synced' : 'this device'} · added {formatDateTime(p.createdAt?.toISOString() ?? null, timeZone)}
                </span>
              </div>
              <RowAction kind="passkey" id={p.id} label="Remove" confirm={`Remove the passkey “${p.name || 'Passkey'}”?`} />
            </div>
          ))}
        </div>
      ) : (
        <span className="mono-sm">No passkeys yet. A passkey signs you in with your device’s fingerprint, face or PIN — no password or code needed.</span>
      )}
    </section>
  );
}
