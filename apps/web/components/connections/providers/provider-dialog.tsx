'use client';

import { useMemo, useState, useTransition } from 'react';
import { AlertBanner } from '@/components/ui/alert-banner';
import { Modal } from '@/components/ui/modal';
import { createProviderAction, deleteProviderAction, updateProviderAction } from '@/lib/actions/models';
import type { ProviderKind, ProviderKindView } from '@/lib/api/models';
import { ConfirmAction } from '../confirm-action';
import { credentialsFromValues, initialFieldValues, settingsFromValues, type FieldValue } from '../models/provider-form';
import { useCloseTo } from '../routed-modal';
import { CredentialFields } from './credential-fields';
import { DescriptorField } from './descriptor-field';

/** What the edit dialog needs about a stored provider: credential NAMES only, never refs or values. */
export interface ProviderFormModel {
  id: string;
  kind: ProviderKind;
  name: string;
  region: string | null;
  residencyZone: string | null;
  settings: Record<string, unknown>;
  credentialKeys: string[];
  enabled: boolean;
  maxConcurrency: number;
  profileNames: string[];
}

interface Props {
  kinds: ProviderKindView[];
  initialKind: ProviderKind | null;
  provider: ProviderFormModel | null;
  closeHref: string;
}

const FORM_ID = 'provider-form';

/** Add / edit a model provider (POST, PATCH /v1/model-providers). Settings and credential fields come from the kind's descriptors. */
export function ProviderDialog({ kinds, initialKind, provider, closeHref }: Props) {
  const close = useCloseTo(closeHref);
  const editing = provider !== null;
  // The first kind the API offers; a stored provider keeps its own kind, even one this deployment no longer registers.
  const [kind, setKind] = useState<ProviderKind>(provider?.kind ?? initialKind ?? kinds[0]?.kind ?? '');
  const def = kinds.find((k) => k.kind === kind);
  const [name, setName] = useState(provider?.name ?? def?.label ?? '');
  const [region, setRegion] = useState(provider?.region ?? '');
  const [zone, setZone] = useState(provider?.residencyZone ?? '');
  const [enabled, setEnabled] = useState(provider?.enabled ?? true);
  const [maxConcurrency, setMaxConcurrency] = useState(String(provider?.maxConcurrency ?? 50));
  const [settings, setSettings] = useState<Record<string, FieldValue>>(() => initialFieldValues(def?.settings ?? [], provider?.settings ?? null));
  const [creds, setCreds] = useState<Record<string, string>>({});
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const stored = useMemo(() => (provider ? new Set(provider.credentialKeys) : null), [provider]);

  function chooseKind(next: ProviderKind) {
    const nextDef = kinds.find((k) => k.kind === next);
    if (!editing && (name === '' || name === def?.label)) setName(nextDef?.label ?? '');
    setKind(next);
    setSettings(initialFieldValues(nextDef?.settings ?? [], null));
    setCreds({});
    setErrors({});
  }

  function save() {
    if (!def) return;
    const s = settingsFromValues(def.settings, settings);
    const c = credentialsFromValues(def.credentials, creds, { editing, removed, stored: stored ?? new Set() });
    const concurrency = Number(maxConcurrency);
    const local: Record<string, string> = { ...s.errors, ...Object.fromEntries(Object.entries(c.errors).map(([k, v]) => [`cred:${k}`, v])) };
    if (!name.trim()) local['name'] = 'Enter a name';
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 10_000) local['maxConcurrency'] = 'A whole number from 1 to 10000';
    if (zone.trim() && !/^[A-Za-z0-9-]{1,20}$/.test(zone.trim())) local['zone'] = 'Letters, digits and dashes, e.g. IN or GLOBAL';
    setErrors(local);
    setMessage(null);
    if (Object.keys(local).length) return;
    const common = {
      name: name.trim(),
      region: region.trim() || null,
      residencyZone: zone.trim() || null,
      settings: s.settings,
      enabled,
      maxConcurrency: concurrency,
    };
    start(async () => {
      const result = provider
        ? await updateProviderAction(provider.id, { ...common, credentials: c.credentials })
        : await createProviderAction({
            ...common,
            kind,
            credentials: Object.fromEntries(Object.entries(c.credentials).filter((e): e is [string, string] => e[1] !== null)),
          });
      if (result.ok) close();
      else setMessage(result.message);
    });
  }

  const credErrors = Object.fromEntries(Object.entries(errors).filter(([k]) => k.startsWith('cred:')).map(([k, v]) => [k.slice(5), v]));
  return (
    <Modal
      title={editing ? `Edit ${provider.name}` : 'Add model provider'}
      sub="credentials are write-only"
      onClose={close}
      maxWidth={640}
      footer={
        <>
          <span className="mono-sm">{editing ? 'changes are audited · profiles using it are re-checked' : 'stored by reference · test it after saving'}</span>
          <span className="sp" />
          {provider ? (
            <ConfirmAction
              label="Delete"
              buttonClass="btn danger"
              title={`Delete ${provider.name}`}
              confirmLabel="Delete provider"
              run={() => deleteProviderAction(provider.id)}
              onDone={close}
            >
              {provider.profileNames.length
                ? `Profiles ${provider.profileNames.join(', ')} use this provider; the API refuses the delete until they are reassigned.`
                : 'The provider and its stored credentials are removed. Nothing references it.'}
            </ConfirmAction>
          ) : null}
          <button type="button" className="btn" onClick={close}>
            Cancel
          </button>
          <button type="submit" form={FORM_ID} className="btn accent" disabled={pending || !def}>
            {pending ? 'Saving…' : editing ? 'Save changes' : 'Add provider'}
          </button>
        </>
      }
    >
      <form
        id={FORM_ID}
        noValidate
        style={{ display: 'grid', gap: 14 }}
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        {message ? (
          <AlertBanner tone="error" style={{ margin: 0 }}>
            {message}
          </AlertBanner>
        ) : null}
        {editing ? null : (
          <div className="fld">
            <label htmlFor="pv-kind">Provider</label>
            <select id="pv-kind" value={kind} onChange={(e) => chooseKind(e.target.value)}>
              {kinds.map((k) => (
                <option key={k.kind} value={k.kind}>
                  {k.label}
                </option>
              ))}
            </select>
            {def?.devOnly ? <span className="hint">development only · deterministic scripted replies, never for production</span> : null}
          </div>
        )}
        <div className="fld-row">
          <Text id="pv-name" label="Name" value={name} onChange={setName} error={errors['name']} hint="how cards, profiles and audit entries refer to it" />
          <Text id="pv-region" label="Region (optional)" value={region} onChange={setRegion} hint="e.g. ap-south-1, asia-south1, global" />
        </div>
        <div className="fld-row">
          <Text id="pv-zone" label="Data residency zone (optional)" value={zone} onChange={setZone} error={errors['zone']} hint="where it keeps data, e.g. IN · checked against deployment policy" />
          <Text id="pv-conc" label="Max concurrency" value={maxConcurrency} onChange={setMaxConcurrency} error={errors['maxConcurrency']} type="number" />
        </div>
        <label className="toggle-row">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Enabled — disabled providers are skipped by every profile
        </label>
        <fieldset className="conn-fieldset">
          <legend>Settings</legend>
          {(def?.settings ?? []).map((d) => (
            <DescriptorField
              key={`${kind}-${d.name}`}
              idPrefix="pv-set"
              descriptor={d}
              value={settings[d.name] ?? ''}
              error={errors[d.name]}
              onChange={(v) => setSettings((prev) => ({ ...prev, [d.name]: v }))}
            />
          ))}
        </fieldset>
        <fieldset className="conn-fieldset">
          <legend>Credentials · write-only</legend>
          <CredentialFields
            descriptors={def?.credentials ?? []}
            values={creds}
            errors={credErrors}
            stored={stored}
            removed={removed}
            onChange={(n, v) => setCreds((prev) => ({ ...prev, [n]: v }))}
            onToggleRemove={(n) =>
              setRemoved((prev) => {
                const next = new Set(prev);
                if (next.has(n)) next.delete(n);
                else next.add(n);
                return next;
              })
            }
          />
        </fieldset>
      </form>
    </Modal>
  );
}

function Text(p: { id: string; label: string; value: string; onChange: (v: string) => void; error?: string | undefined; hint?: string; type?: 'text' | 'number' }) {
  return (
    <div className="fld">
      <label htmlFor={p.id}>{p.label}</label>
      <input
        id={p.id}
        type={p.type ?? 'text'}
        value={p.value}
        autoComplete="off"
        onChange={(e) => p.onChange(e.target.value)}
        aria-invalid={p.error ? true : undefined}
        aria-describedby={p.error ? `${p.id}-error` : p.hint ? `${p.id}-hint` : undefined}
      />
      {p.hint ? (
        <span id={`${p.id}-hint`} className="hint">
          {p.hint}
        </span>
      ) : null}
      {p.error ? (
        <span id={`${p.id}-error`} className="err" role="alert">
          {p.error}
        </span>
      ) : null}
    </div>
  );
}
