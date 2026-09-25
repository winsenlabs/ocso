'use client';

import type { ReactNode } from 'react';
import type { CapabilityKey } from '@/lib/api/models';
import { CAPABILITY_LABELS } from '../models/meta';
import type { ProfileFormState } from '../models/profile-form';

export type SetField = <K extends keyof ProfileFormState>(key: K, value: ProfileFormState[K]) => void;

export function Input(p: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string | undefined;
  hint?: ReactNode;
  type?: 'text' | 'number';
  disabled?: boolean;
}) {
  const describedBy = [p.error ? `${p.id}-error` : null, p.hint ? `${p.id}-hint` : null].filter(Boolean).join(' ') || undefined;
  return (
    <div className="fld">
      <label htmlFor={p.id}>{p.label}</label>
      <input
        id={p.id}
        type={p.type ?? 'text'}
        value={p.value}
        step={p.type === 'number' ? 'any' : undefined}
        autoComplete="off"
        disabled={p.disabled}
        onChange={(e) => p.onChange(e.target.value)}
        aria-invalid={p.error ? true : undefined}
        aria-describedby={describedBy}
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

/** Generation limits, retries and timeouts (docs/archive/specs/06 §2). */
export function GenerationFields({ state, set, errors }: { state: ProfileFormState; set: SetField; errors: Record<string, string> }) {
  return (
    <fieldset className="conn-fieldset">
      <legend>Generation</legend>
      <div className="g g3" style={{ gap: 12 }}>
        <Input id="pf-temp" label="Temperature (optional)" type="number" value={state.temperature} onChange={(v) => set('temperature', v)} error={errors['temperature']} hint="0–2 · blank = provider default" />
        <Input id="pf-max" label="Max output tokens" type="number" value={state.maxOutputTokens} onChange={(v) => set('maxOutputTokens', v)} error={errors['maxOutputTokens']} />
        <div className="fld">
          <label htmlFor="pf-reason">Reasoning</label>
          <select id="pf-reason" value={state.reasoning} onChange={(e) => set('reasoning', e.target.value as ProfileFormState['reasoning'])}>
            <option value="">Provider default</option>
            <option value="none">Off</option>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </select>
        </div>
        <Input id="pf-timeout" label="Timeout (seconds)" type="number" value={state.timeoutSeconds} onChange={(v) => set('timeoutSeconds', v)} error={errors['timeoutSeconds']} />
        <Input id="pf-retries" label="Retries" type="number" value={state.retries} onChange={(v) => set('retries', v)} error={errors['retries']} hint="per target, before falling back" />
        <Input id="pf-backoff" label="Retry backoff (ms)" type="number" value={state.retryBackoffMs} onChange={(v) => set('retryBackoffMs', v)} error={errors['retryBackoffMs']} />
      </div>
    </fieldset>
  );
}

/** Profile-level cache settings; what each target does with them is shown in the policy check table. */
export function CacheFields({ state, set }: { state: ProfileFormState; set: SetField }) {
  return (
    <fieldset className="conn-fieldset">
      <legend>Prompt caching</legend>
      <div className="fld-row">
        <div className="fld">
          <label htmlFor="pf-cache">Cache policy</label>
          <select id="pf-cache" value={state.cachePolicy} onChange={(e) => set('cachePolicy', e.target.value as ProfileFormState['cachePolicy'])}>
            <option value="PREFIX">Prefix cache · stable components first</option>
            <option value="OFF">Off</option>
          </select>
          <span className="hint">the prompt compiler orders stable content first either way</span>
        </div>
        <div className="fld">
          <label htmlFor="pf-ttl">Cache TTL</label>
          <select id="pf-ttl" value={state.cacheTtl} disabled={state.cachePolicy === 'OFF'} onChange={(e) => set('cacheTtl', e.target.value as ProfileFormState['cacheTtl'])}>
            <option value="">Provider default (5m)</option>
            <option value="5m">5 minutes</option>
            <option value="1h">1 hour (longer retention where supported)</option>
          </select>
        </div>
      </div>
    </fieldset>
  );
}

const KEYS = Object.keys(CAPABILITY_LABELS) as CapabilityKey[];

/** Capabilities every target must have; targets lacking one are rejected or skipped. */
export function CapabilityFields({ state, set }: { state: ProfileFormState; set: SetField }) {
  return (
    <fieldset className="conn-fieldset">
      <legend>Required capabilities</legend>
      <div className="checks">
        {KEYS.map((k) => (
          <label key={k}>
            <input type="checkbox" checked={state.capabilities[k] === true} onChange={(e) => set('capabilities', { ...state.capabilities, [k]: e.target.checked })} />
            {CAPABILITY_LABELS[k]}
          </label>
        ))}
      </div>
      <span className="mono-sm">e.g. require image input for a channel that receives photos; a fallback without it is skipped</span>
    </fieldset>
  );
}
