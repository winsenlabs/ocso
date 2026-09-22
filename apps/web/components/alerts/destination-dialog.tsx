'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { AlertBanner } from '@/components/ui/alert-banner';
import { Modal } from '@/components/ui/modal';
import { createDestinationAction, deleteDestinationAction, updateDestinationAction } from '@/lib/actions/alerts';
import type { NotificationDestination } from '@/lib/api/alerts';
import { ConfirmButton } from './confirm-button';
import { DESTINATION_SPECS, buildConfig, configText, specOf } from './destination-form';

/** Add or edit a notification destination (POST / PATCH /v1/notification-destinations). Secrets are write-only. */
export function DestinationDialog({ destination, closeHref }: { destination: NotificationDestination | null; closeHref: string }) {
  const router = useRouter();
  const close = () => router.replace(closeHref, { scroll: false });
  const [kind, setKind] = useState(destination?.kind ?? 'IN_APP');
  const [name, setName] = useState(destination?.name ?? '');
  const [text, setText] = useState<Record<string, string>>(() => configText(destination?.kind ?? 'IN_APP', destination?.config ?? null));
  const [secret, setSecret] = useState('');
  const [enabled, setEnabled] = useState(destination?.enabled ?? true);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const spec = specOf(kind);

  function save() {
    setError(null);
    const body = { name, config: buildConfig(kind, text), enabled, ...(secret ? { secret } : {}) };
    start(async () => {
      const r = destination ? await updateDestinationAction(destination.id, body) : await createDestinationAction({ ...body, kind });
      if (r.ok) close();
      else setError(r.message);
    });
  }

  return (
    <Modal
      title={destination ? `Destination · ${destination.name}` : 'Add notification destination'}
      sub={spec.receives ? `receives ${spec.receives}` : undefined}
      onClose={close}
      maxWidth={640}
      footer={
        <>
          {destination ? (
            <ConfirmButton label="Delete destination" confirmLabel="Delete" run={() => deleteDestinationAction(destination.id)} onDone={close}>
              Rules stop delivering here and its stored secret is deleted.
            </ConfirmButton>
          ) : null}
          <span className="sp" />
          <button type="button" className="btn" onClick={close}>
            Cancel
          </button>
          <button type="submit" form="destination-form" className="btn accent" disabled={pending}>
            {pending ? 'Saving…' : destination ? 'Save destination' : 'Add destination'}
          </button>
        </>
      }
    >
      <div aria-live="polite">
        {error ? (
          <AlertBanner tone="error" style={{ margin: 0 }}>
            {error}
          </AlertBanner>
        ) : null}
      </div>
      <form
        id="destination-form"
        noValidate
        style={{ display: 'grid', gap: 14 }}
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <div className="fld-row">
          <div className="fld">
            <label htmlFor="dest-name">Destination name</label>
            <input id="dest-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
          </div>
          <div className="fld">
            <label htmlFor="dest-kind">Type</label>
            <select
              id="dest-kind"
              value={kind}
              disabled={Boolean(destination)}
              onChange={(e) => {
                setKind(e.target.value);
                setText(configText(e.target.value, null));
                setSecret('');
              }}
            >
              {Object.entries(DESTINATION_SPECS).map(([k, s]) => (
                <option key={k} value={k}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
        </div>
        {spec.fields.length ? (
          <div className="fld-row">
            {spec.fields.map((f) => {
              const id = `dest-${f.name}`;
              const value = text[f.name] ?? '';
              const set = (v: string) => setText((t) => ({ ...t, [f.name]: v }));
              return (
                <div className="fld" key={f.name}>
                  <label htmlFor={id}>
                    {f.label}
                    {f.optional ? ' (optional)' : ''}
                  </label>
                  {f.kind === 'select' || f.kind === 'boolean' ? (
                    <select id={id} value={value} onChange={(e) => set(e.target.value)}>
                      {(f.kind === 'boolean' ? ['true', 'false'] : (f.options ?? [])).map((o) => (
                        <option key={o} value={o}>
                          {f.kind === 'boolean' ? (o === 'true' ? 'yes' : 'no') : o}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input id={id} value={value} inputMode={f.kind === 'number' ? 'numeric' : undefined} onChange={(e) => set(e.target.value)} />
                  )}
                  {f.hint ? <span className="hint">{f.hint}</span> : null}
                </div>
              );
            })}
          </div>
        ) : (
          <span className="mono-sm">In-app alerts appear in the OCSO alert inbox for the rule&apos;s audience. No configuration needed.</span>
        )}
        {spec.secret ? (
          <div className="fld">
            <label htmlFor="dest-secret">
              {spec.secret.label}
              {spec.secret.required ? '' : ' (optional)'}
            </label>
            <input id="dest-secret" type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} />
            <span className="hint">
              {destination?.hasSecret ? 'stored · leave blank to keep it, type to replace it' : 'stored in the secret store by reference; never shown again'}
            </span>
          </div>
        ) : null}
        <label className="toggle-row">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Enabled — disabled destinations receive nothing
        </label>
      </form>
    </Modal>
  );
}
