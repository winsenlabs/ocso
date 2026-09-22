'use client';

import { MAX_FALLBACKS, moveTarget, newTargetKey, type TargetRow } from '../models/profile-form';

export interface ProviderOption {
  id: string;
  name: string;
  kindLabel: string;
  region: string | null;
  residencyZone: string | null;
  enabled: boolean;
}

export function providerOptionLabel(p: ProviderOption): string {
  return `${p.name} · ${p.kindLabel}${p.region ? ` · ${p.region}` : ''}${p.enabled ? '' : ' (disabled)'}`;
}

/** Ordered fallback targets (docs/06 §5): tried in order, only when the policy permits. */
export function FallbackEditor({ rows, providers, onChange, error }: { rows: TargetRow[]; providers: ProviderOption[]; onChange: (rows: TargetRow[]) => void; error: string | undefined }) {
  const update = (i: number, patch: Partial<TargetRow>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <fieldset className="conn-fieldset" aria-describedby={error ? 'pf-fallbacks-error' : undefined}>
      <legend>Fallback targets · in order</legend>
      {rows.length === 0 ? <span className="mono-sm">No fallback: a failed call surfaces as an error (and may hand off to a human).</span> : null}
      {rows.map((row, i) => (
        <div className="fb-row" key={row.key}>
          <span className="mono-sm fb-n">{i + 1}</span>
          <div className="fld">
            <label htmlFor={`pf-fb-p-${row.key}`}>Fallback {i + 1} provider</label>
            <select id={`pf-fb-p-${row.key}`} value={row.providerId} onChange={(e) => update(i, { providerId: e.target.value })}>
              <option value="">Choose a provider</option>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {providerOptionLabel(p)}
                </option>
              ))}
            </select>
          </div>
          <div className="fld">
            <label htmlFor={`pf-fb-m-${row.key}`}>Fallback {i + 1} model</label>
            <input id={`pf-fb-m-${row.key}`} value={row.model} autoComplete="off" onChange={(e) => update(i, { model: e.target.value })} />
          </div>
          <span className="fb-actions">
            <button type="button" className="icon-btn" aria-label={`Move fallback ${i + 1} up`} disabled={i === 0} onClick={() => onChange(moveTarget(rows, i, -1))}>
              ↑
            </button>
            <button
              type="button"
              className="icon-btn"
              aria-label={`Move fallback ${i + 1} down`}
              disabled={i === rows.length - 1}
              onClick={() => onChange(moveTarget(rows, i, 1))}
            >
              ↓
            </button>
            <button type="button" className="icon-btn" aria-label={`Remove fallback ${i + 1}`} onClick={() => onChange(rows.filter((_, j) => j !== i))}>
              ✕
            </button>
          </span>
        </div>
      ))}
      {error ? (
        <span id="pf-fallbacks-error" className="err" role="alert">
          {error}
        </span>
      ) : null}
      <div>
        <button
          type="button"
          className="btn tiny"
          disabled={rows.length >= MAX_FALLBACKS}
          onClick={() => onChange([...rows, { key: newTargetKey(), providerId: providers[0]?.id ?? '', model: '' }])}
        >
          Add fallback
        </button>
      </div>
    </fieldset>
  );
}
