'use client';

import type { ChannelSecretField } from '@/lib/api/channels';
import { CopyButton } from '../copy-button';
import { randomSecret } from './settings-form';

interface Props {
  fields: ChannelSecretField[];
  values: Record<string, string>;
  /** Values generated in this dialog, shown once so the admin can copy them (e.g. into Meta). */
  generated: Record<string, string>;
  errors: Record<string, string>;
  /** Secret names already stored (edit); null on create. */
  stored: ReadonlySet<string> | null;
  onChange: (key: string, value: string, generated: boolean) => void;
}

/**
 * Channel secrets: write-only. Stored ones show only "set"; a blank field
 * keeps the stored value (edit) or, for server-generated secrets, lets OCSO
 * generate one (create). Client-generated secrets are shown once to copy.
 */
export function SecretFields({ fields, values, generated, errors, stored, onChange }: Props) {
  if (!fields.length) return <span className="mono-sm">This channel needs no secrets.</span>;
  return (
    <>
      {fields.map((f) => {
        const id = `ch-sec-${f.key}`;
        const isSet = stored?.has(f.key) ?? false;
        const shown = generated[f.key];
        const error = errors[f.key];
        const optional = !f.required || isSet || (f.generate === 'server' && !stored);
        const placeholder = isSet ? 'stored · leave blank to keep it' : f.generate === 'server' ? 'leave blank and OCSO generates it' : '';
        return (
          <div className="fld" key={f.key}>
            <label htmlFor={id}>
              {f.label}
              {optional ? ' (optional)' : ''}
              {stored ? ' ' : null}
              {stored ? <span className={isSet ? 'cred-state set' : 'cred-state'}>{isSet ? 'set' : 'not set'}</span> : null}
            </label>
            <div className="rowsplit" style={{ flexWrap: 'nowrap' }}>
              <input
                id={id}
                type="password"
                autoComplete="new-password"
                spellCheck={false}
                value={values[f.key] ?? ''}
                placeholder={placeholder}
                onChange={(e) => onChange(f.key, e.target.value, false)}
                aria-invalid={error ? true : undefined}
                aria-describedby={`${id}-hint${error ? ` ${id}-error` : ''}`}
                style={{ flex: 1 }}
              />
              {f.generate === 'client' ? (
                <button type="button" className="btn tiny" onClick={() => onChange(f.key, `${f.prefix ?? ''}${randomSecret()}`, true)} aria-label={`Generate ${f.label}`}>
                  Generate
                </button>
              ) : f.reveal === 'once' && stored ? (
                <button type="button" className="btn tiny" onClick={() => onChange(f.key, `${f.prefix ?? ''}${randomSecret()}`, true)} style={{ whiteSpace: 'nowrap' }}>
                  {isSet ? 'Rotate' : 'Generate'} {f.label.toLowerCase()}
                </button>
              ) : null}
            </div>
            <span id={`${id}-hint`} className="hint">
              {f.hint ? `${f.hint} · ` : ''}
              {f.reveal === 'once' ? 'shown once when generated · ' : ''}write-only · stored by reference
            </span>
            {shown && values[f.key] === shown ? (
              <div className="generated-secret" role="status">
                <code className="secret-once" aria-label={`Generated ${f.label}`}>
                  {shown}
                </code>
                <CopyButton value={shown} what={f.label} />
                <span className="mono-sm">
                  copy it now · after saving OCSO never shows it again{f.reveal === 'once' && isSet ? ' · it replaces the current key once this change is saved (or approved)' : ''}
                </span>
              </div>
            ) : null}
            {error ? (
              <span id={`${id}-error`} className="err" role="alert">
                {error}
              </span>
            ) : null}
          </div>
        );
      })}
    </>
  );
}
