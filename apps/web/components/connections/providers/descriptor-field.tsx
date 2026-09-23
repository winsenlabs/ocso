'use client';

import type { FieldDescriptor } from '@/lib/api/models';
import { isTriState, type FieldValue } from '../models/provider-form';

interface Props {
  descriptor: FieldDescriptor;
  value: FieldValue;
  error: string | undefined;
  onChange: (value: FieldValue) => void;
  idPrefix: string;
}

function hintOf(d: FieldDescriptor): string | undefined {
  const parts = [d.description, d.default !== undefined && d.type !== 'boolean' && d.type !== 'json' ? `default ${String(d.default)}` : undefined];
  const text = parts.filter(Boolean).join(' · ');
  return text || undefined;
}

/** One non-secret provider setting rendered from its descriptor (string, url, number, boolean, enum or JSON). */
export function DescriptorField({ descriptor: d, value, error, onChange, idPrefix }: Props) {
  const id = `${idPrefix}-${d.name}`;
  const hint = hintOf(d);
  const describedBy = [error ? `${id}-error` : null, hint ? `${id}-hint` : null].filter(Boolean).join(' ') || undefined;
  const label = `${d.label}${d.required ? '' : ' (optional)'}`;

  if (d.type === 'boolean' && !isTriState(d)) {
    return (
      <label className="toggle-row">
        <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} aria-describedby={describedBy} />
        {d.label}
      </label>
    );
  }

  let control;
  if (d.type === 'boolean') {
    control = (
      <select id={id} value={String(value)} onChange={(e) => onChange(e.target.value)} aria-describedby={describedBy}>
        <option value="">Provider decides</option>
        <option value="true">On</option>
        <option value="false">Off</option>
      </select>
    );
  } else if (d.type === 'enum') {
    control = (
      <select id={id} value={String(value)} onChange={(e) => onChange(e.target.value)} aria-describedby={describedBy} aria-invalid={error ? true : undefined}>
        {d.required || d.default !== undefined ? null : <option value="">Not set</option>}
        {(d.options ?? []).map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    );
  } else if (d.type === 'json') {
    control = (
      <textarea
        id={id}
        rows={3}
        className="mono"
        value={String(value)}
        placeholder="{ }"
        onChange={(e) => onChange(e.target.value)}
        aria-describedby={describedBy}
        aria-invalid={error ? true : undefined}
      />
    );
  } else {
    control = (
      <input
        id={id}
        type={d.type === 'integer' || d.type === 'number' ? 'number' : d.type === 'url' ? 'url' : 'text'}
        value={String(value)}
        min={d.type === 'integer' || d.type === 'number' ? d.min : undefined}
        max={d.type === 'integer' || d.type === 'number' ? d.max : undefined}
        step={d.type === 'number' ? 'any' : undefined}
        onChange={(e) => onChange(e.target.value)}
        autoComplete="off"
        aria-describedby={describedBy}
        aria-invalid={error ? true : undefined}
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
