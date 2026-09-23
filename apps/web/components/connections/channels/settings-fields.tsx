'use client';

import type { SettingsField, SettingsGroup } from './settings-form';

interface Props {
  group: SettingsGroup;
  values: Record<string, string | boolean>;
  errors: Record<string, string>;
  onChange: (path: string, value: string | boolean) => void;
}

const idOf = (path: string) => `ch-set-${path.replace(/\./g, '-')}`;
const fmt = (v: unknown) => (Array.isArray(v) ? (v.length ? v.join(', ') : 'none') : typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v));

function Field({ f, value, error, onChange }: { f: SettingsField; value: string | boolean; error: string | undefined; onChange: (v: string | boolean) => void }) {
  const id = idOf(f.path);
  const hasDefault = f.defaultValue !== undefined;
  const hint = [f.description, f.kind === 'list' ? 'one per line' : null, hasDefault && f.kind !== 'boolean' && f.kind !== 'enum' ? `blank = default ${fmt(f.defaultValue)}` : null]
    .filter(Boolean)
    .join(' · ');
  const describedBy = [error ? `${id}-error` : null, hint ? `${id}-hint` : null].filter(Boolean).join(' ') || undefined;
  const common = { id, 'aria-invalid': error ? true : undefined, 'aria-describedby': describedBy } as const;
  const label = `${f.label}${f.required ? '' : ' (optional)'}`;

  if (f.kind === 'boolean') {
    return (
      <label className="toggle-row">
        <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} aria-describedby={describedBy} />
        {f.label}
      </label>
    );
  }
  let control;
  if (f.kind === 'enum') {
    control = (
      <select {...common} value={String(value)} onChange={(e) => onChange(e.target.value)}>
        {f.required && !hasDefault ? null : <option value="">{hasDefault ? `Default (${fmt(f.defaultValue)})` : 'Not set'}</option>}
        {f.options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    );
  } else if (f.kind === 'list' || f.kind === 'json') {
    control = <textarea {...common} rows={3} value={String(value)} onChange={(e) => onChange(e.target.value)} spellCheck={false} />;
  } else {
    const numeric = f.kind === 'number' || f.kind === 'integer';
    control = (
      <input
        {...common}
        type={numeric ? 'number' : 'text'}
        step={f.kind === 'number' ? 'any' : undefined}
        min={numeric ? (f.minimum ?? undefined) : undefined}
        max={numeric ? (f.maximum ?? undefined) : undefined}
        value={String(value)}
        placeholder={hasDefault ? fmt(f.defaultValue) : undefined}
        autoComplete="off"
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  return (
    <div className="fld">
      <label htmlFor={id}>{label}</label>
      {control}
      {hint ? (
        <span id={`${id}-hint`} className="hint">
          {hint}
        </span>
      ) : null}
      {error ? (
        <span id={`${id}-error`} className="err" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}

/** Settings rendered from the channel kind's JSON Schema; nested objects become their own field groups. */
export function SettingsFields({ group, values, errors, onChange }: Props) {
  const body = (
    <>
      <div className="fld-row">
        {group.fields
          .filter((f) => f.kind !== 'boolean' && f.kind !== 'list' && f.kind !== 'json')
          .map((f) => (
            <Field key={f.path} f={f} value={values[f.path] ?? ''} error={errors[f.path]} onChange={(v) => onChange(f.path, v)} />
          ))}
      </div>
      {group.fields
        .filter((f) => f.kind === 'list' || f.kind === 'json' || f.kind === 'boolean')
        .map((f) => (
          <Field key={f.path} f={f} value={values[f.path] ?? ''} error={errors[f.path]} onChange={(v) => onChange(f.path, v)} />
        ))}
      {group.groups.map((g) => (
        <SettingsFields key={g.path} group={g} values={values} errors={errors} onChange={onChange} />
      ))}
    </>
  );
  if (!group.path) return body;
  return (
    <fieldset className="conn-fieldset">
      <legend>{group.label}</legend>
      {body}
    </fieldset>
  );
}
