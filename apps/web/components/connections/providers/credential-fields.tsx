'use client';

import type { FieldDescriptor } from '@/lib/api/models';

interface Props {
  descriptors: FieldDescriptor[];
  values: Record<string, string>;
  errors: Record<string, string>;
  /** Credential names already stored (edit mode); values are never sent to the browser. */
  stored: ReadonlySet<string> | null;
  removed: ReadonlySet<string>;
  onChange: (name: string, value: string) => void;
  onToggleRemove: (name: string) => void;
}

/**
 * Write-only credentials: typed once, stored in the secret store, never shown
 * again. Existing credentials show only "set" / "not set".
 */
export function CredentialFields({ descriptors, values, errors, stored, removed, onChange, onToggleRemove }: Props) {
  if (!descriptors.length) return <span className="mono-sm">This provider needs no credentials.</span>;
  return (
    <>
      {descriptors.map((d) => {
        const id = `pv-cred-${d.name}`;
        const isSet = stored?.has(d.name) ?? false;
        const removing = removed.has(d.name);
        const error = errors[d.name];
        return (
          <div className="fld" key={d.name}>
            <label htmlFor={id}>
              {d.label}
              {d.required ? '' : ' (optional)'}
              {stored ? ' ' : null}
              {stored ? (
                <span className={isSet && !removing ? 'cred-state set' : 'cred-state'}>{removing ? 'will be removed' : isSet ? 'set' : 'not set'}</span>
              ) : null}
            </label>
            <input
              id={id}
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              value={values[d.name] ?? ''}
              placeholder={isSet ? 'leave blank to keep the stored value' : ''}
              onChange={(e) => onChange(d.name, e.target.value)}
              disabled={removing}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? `${id}-error` : `${id}-hint`}
            />
            <span id={`${id}-hint`} className="hint">
              {d.description ? `${d.description} · ` : ''}write-only · stored by reference
            </span>
            {isSet && !d.required ? (
              <label className="toggle-row">
                <input type="checkbox" checked={removing} onChange={() => onToggleRemove(d.name)} />
                Remove the stored {d.label.toLowerCase()}
              </label>
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
