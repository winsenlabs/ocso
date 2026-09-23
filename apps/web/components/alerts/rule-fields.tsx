'use client';

import type { ParamField } from './rule-params';

/** Inputs for a condition's params, generated from its JSON Schema (rule-params.ts). */
export function ParamInputs({
  fields,
  values,
  errors,
  onChange,
}: {
  fields: ParamField[];
  values: Record<string, string>;
  errors: Record<string, string>;
  onChange: (name: string, value: string) => void;
}) {
  if (fields.length === 0) return <span className="mono-sm">this condition takes no parameters</span>;
  return (
    <div className="fld-row">
      {fields.map((f) => {
        const id = `rp-${f.name}`;
        const value = values[f.name] ?? '';
        const bounds = f.min !== null || f.max !== null ? `${f.min ?? '…'} – ${f.max ?? '…'}` : null;
        const hint = [f.description, bounds, f.defaultText ? `default ${f.defaultText}` : 'optional'].filter(Boolean).join(' · ');
        const error = errors[f.name];
        const describedBy = `${id}-hint${error ? ` ${id}-err` : ''}`;
        let input;
        if (f.kind === 'enum') {
          input = (
            <select id={id} value={value} onChange={(e) => onChange(f.name, e.target.value)} aria-describedby={describedBy}>
              {f.defaultText ? null : <option value="">—</option>}
              {f.options.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          );
        } else if (f.kind === 'boolean') {
          input = (
            <select id={id} value={value} onChange={(e) => onChange(f.name, e.target.value)} aria-describedby={describedBy}>
              <option value="true">yes</option>
              <option value="false">no</option>
            </select>
          );
        } else {
          input = (
            <input
              id={id}
              type="text"
              inputMode={f.kind === 'number' || f.kind === 'integer' ? 'decimal' : undefined}
              value={value}
              onChange={(e) => onChange(f.name, e.target.value)}
              aria-invalid={error ? true : undefined}
              aria-describedby={describedBy}
              placeholder={f.kind === 'list' || f.kind === 'enum-list' ? 'comma separated' : undefined}
            />
          );
        }
        return (
          <div className="fld" key={f.name}>
            <label htmlFor={id}>{f.label}</label>
            {input}
            <span className="hint" id={`${id}-hint`}>
              {f.kind === 'enum-list' ? `${hint} · one of ${f.options.join(', ')}` : hint}
            </span>
            {error ? (
              <span className="err" id={`${id}-err`} role="alert">
                {error}
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export function CheckList({
  legend,
  options,
  value,
  onChange,
  empty,
}: {
  legend: string;
  options: Array<{ value: string; label: string }>;
  value: string[];
  onChange: (next: string[]) => void;
  empty?: string;
}) {
  return (
    <fieldset className="fld" style={{ border: 'none', padding: 0, margin: 0 }}>
      <legend style={{ fontSize: 12, color: 'var(--ink-2)', fontWeight: 500, padding: 0, marginBottom: 5 }}>{legend}</legend>
      {options.length === 0 ? (
        <span className="mono-sm">{empty ?? 'none available'}</span>
      ) : (
        <div className="checks">
          {options.map((o) => (
            <label key={o.value}>
              <input
                type="checkbox"
                checked={value.includes(o.value)}
                onChange={(e) => onChange(e.target.checked ? [...value, o.value] : value.filter((v) => v !== o.value))}
              />
              {o.label}
            </label>
          ))}
        </div>
      )}
    </fieldset>
  );
}
