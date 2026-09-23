'use client';

import { useState } from 'react';

export interface FilterChipOption {
  key: string;
  label: string;
  count?: number | undefined;
}

export interface FilterChipsProps {
  options: FilterChipOption[];
  /** Controlled value; omit to let the chips manage their own selection. */
  value?: string;
  defaultValue?: string;
  onChange?: (key: string) => void;
  label: string;
  size?: 'sm';
}

/** Single-select filter chips (.fchip) with optional mono counts. */
export function FilterChips({ options, value, defaultValue, onChange, label, size }: FilterChipsProps) {
  const [internal, setInternal] = useState(defaultValue ?? options[0]?.key ?? '');
  const selected = value ?? internal;
  return (
    <div role="group" aria-label={label} style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
      {options.map((o) => {
        const on = o.key === selected;
        return (
          <button
            key={o.key}
            type="button"
            className={on ? 'fchip active' : 'fchip'}
            aria-pressed={on}
            style={size === 'sm' ? { fontSize: 11, padding: '3px 9px' } : undefined}
            onClick={() => {
              setInternal(o.key);
              onChange?.(o.key);
            }}
          >
            {o.label}
            {o.count !== undefined ? <span className="fchip-count">{o.count.toLocaleString('en')}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
