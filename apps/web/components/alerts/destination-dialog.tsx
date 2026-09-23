'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';
import { AlertBanner } from '@/components/ui/alert-banner';
import { Modal } from '@/components/ui/modal';
import { useApprovalRequest } from '@/components/approvals/use-approval-request';
import { DeleteByApproval } from '@/components/connections/lifecycle-actions';
import { createDestinationAction, updateDestinationAction } from '@/lib/actions/alerts';
import type { DestinationKindInfo, NotificationDestination } from '@/lib/api/alerts';
import { SettingsFields } from '../connections/channels/settings-fields';
import type { FormValues } from '../workspace/lib/schema-form';
import { activeVariant, buildDestinationConfig, configForm, initialConfigValues, receivesText, secretApplies } from './destination-form';

interface Props {
  destination: NotificationDestination | null;
  /** Registered destination kinds (GET /v1/notification-destinations/kinds), in registry order. */
  kinds: DestinationKindInfo[];
  closeHref: string;
}

/**
 * Add or edit a notification destination (POST / PATCH /v1/notification-destinations).
 * The config form renders from the kind's JSON Schema; secrets are write-only.
 */
export function DestinationDialog({ destination, kinds, closeHref }: Props) {
  const router = useRouter();
  const close = () => router.replace(closeHref, { scroll: false });
  const [kind, setKind] = useState(destination?.kind ?? kinds[0]?.kind ?? '');
  const info = kinds.find((k) => k.kind === kind) ?? null;
  const form = useMemo(() => configForm(info?.configSchema ?? {}), [info]);
  const [name, setName] = useState(destination?.name ?? '');
  const [values, setValues] = useState<FormValues>(() => initialConfigValues(form, destination?.config ?? null));
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [secret, setSecret] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const approval = useApprovalRequest();
  const variant = activeVariant(form, values);
  const hasFields = variant.group.fields.length > 0 || variant.group.groups.length > 0;
  const showSecret = secretApplies(info?.secret ?? null, values);
  const set = (path: string, value: string | boolean) => setValues((v) => ({ ...v, [path]: value }));

  function save() {
    setError(null);
    const built = buildDestinationConfig(form, values);
    setFieldErrors(built.errors);
    if (Object.keys(built.errors).length) return;
    const body = { name, config: built.config, ...(secret && showSecret ? { secret } : {}) };
    if (destination) {
      // A draft saves directly; an approved destination asks for a checker (a new secret travels as a ref).
      approval.run({ objectKind: 'notification_destination', objectId: destination.id, title: `Change destination ${destination.name}` }, (choice) => updateDestinationAction(destination.id, body, choice), {
        onApplied: () => close(),
      });
      return;
    }
    start(async () => {
      const r = await createDestinationAction({ ...body, kind });
      if (r.ok) close();
      else setError(r.message);
    });
  }

  return (
    <Modal
      title={destination ? `Destination · ${destination.name}` : 'Add notification destination'}
      sub={info ? `receives ${receivesText(info.events)}` : undefined}
      onClose={close}
      maxWidth={640}
      footer={
        <>
          {destination ? (
            <DeleteByApproval
              kind="notification_destination"
              id={destination.id}
              name={destination.name}
              buttonClass="btn danger"
              detail="Once a second person approves, rules stop delivering here and its stored secret is deleted."
            />
          ) : null}
          <span className="sp" />
          <button type="button" className="btn" onClick={close}>
            Cancel
          </button>
          <button type="submit" form="destination-form" className="btn accent" disabled={pending || !info}>
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
        {!info ? (
          <AlertBanner tone="error" style={{ margin: 0 }}>
            {destination ? `No delivery adapter is registered for ${destination.kind}; this destination cannot be edited.` : 'No destination types are available.'}
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
                const next = kinds.find((k) => k.kind === e.target.value);
                setKind(e.target.value);
                setValues(initialConfigValues(configForm(next?.configSchema ?? {}), null));
                setFieldErrors({});
                setSecret('');
              }}
            >
              {destination && !info ? <option value={destination.kind}>{destination.kind}</option> : null}
              {kinds.map((k) => (
                <option key={k.kind} value={k.kind}>
                  {k.label}
                </option>
              ))}
            </select>
          </div>
        </div>
        {info?.description ? <span className="mono-sm">{info.description}</span> : null}
        {form.variantKey ? (
          <div className="fld">
            <label htmlFor="dest-variant">{form.variantLabel}</label>
            <select id="dest-variant" value={variant.value} onChange={(e) => set(form.variantKey!, e.target.value)}>
              {form.variants.map((v) => (
                <option key={v.value} value={v.value}>
                  {v.label}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        {hasFields ? <SettingsFields group={variant.group} values={values} errors={fieldErrors} onChange={set} /> : null}
        {info?.secret && showSecret ? (
          <div className="fld">
            <label htmlFor="dest-secret">
              {info.secret.label}
              {info.secret.required ? '' : ' (optional)'}
            </label>
            <input id="dest-secret" type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} aria-describedby="dest-secret-hint" />
            <span id="dest-secret-hint" className="hint">
              {info.secret.description} · {destination?.hasSecret ? 'stored · leave blank to keep it, type to replace it' : 'stored in the secret store by reference; never shown again'}
            </span>
          </div>
        ) : null}
        {destination ? null : <span className="hint">A new destination is a disabled draft: enable it from its row once saved (a second person approves).</span>}
        {approval.error || approval.notice ? <span className={approval.error ? 'err-text' : 'mono-sm'}>{approval.error ?? approval.notice}</span> : null}
        {approval.modal}
      </form>
    </Modal>
  );
}
