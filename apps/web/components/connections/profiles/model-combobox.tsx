'use client';

import { useId, useMemo, useState, type KeyboardEvent } from 'react';
import '@/app/styles/model-picker.css';
import { capabilityLine, filterModelOptions, listSummary, optionMeta, priceLine } from './model-options';
import { useProviderModels } from './use-provider-models';

interface Props {
  id: string;
  label: string;
  providerId: string;
  /** For the status line, e.g. "OpenAI". */
  providerLabel: string;
  value: string;
  onChange: (value: string) => void;
  /** Tech admins (providers.manage) may bypass the ten-minute listing cache. */
  canRefresh: boolean;
  error?: string | undefined;
}

/**
 * Searchable model picker fed by the provider's own model list (ARIA 1.2
 * combobox). Free text always works: a model the list does not return (a
 * fine-tune, a brand-new id) can be typed. The chosen model's capabilities
 * and price (configured row, else the catalog's offer) show underneath.
 */
export function ModelCombobox({ id, label, providerId, providerLabel, value, onChange, canRefresh, error }: Props) {
  const { state, reload } = useProviderModels(providerId);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();
  const list = state?.status === 'ready' ? state.list : state?.status === 'loading' ? state.list : null;
  const models = useMemo(() => list?.models ?? [], [list]);
  const shown = useMemo(() => filterModelOptions(models, value), [models, value]);
  const selected = models.find((m) => m.id === value.trim());
  const expanded = open && shown.length > 0;
  const activeIndex = Math.min(active, shown.length - 1);

  function choose(modelId: string) {
    onChange(modelId);
    setOpen(false);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) setOpen(true);
      else setActive((i) => Math.max(0, Math.min(shown.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1))));
    } else if (e.key === 'Enter' && expanded && shown[activeIndex]) {
      e.preventDefault();
      choose(shown[activeIndex].id);
    } else if (e.key === 'Escape' && open) {
      e.preventDefault();
      setOpen(false);
    }
  }

  const status =
    state === null
      ? null
      : state.status === 'failed'
        ? `Could not list ${providerLabel} models: ${state.message} You can still type a model id.`
        : state.status === 'loading'
          ? `Loading ${providerLabel} models…`
          : listSummary(state.list, providerLabel);
  const devOnly = list?.devOnly ?? false;
  const price = selected ? priceLine(selected, devOnly) : null;
  const describedBy = [`${id}-status`, `${id}-detail`, error ? `${id}-error` : null].filter(Boolean).join(' ');

  return (
    <div className="fld mpick">
      <label htmlFor={id}>{label}</label>
      <div className="mpick-row">
        <input
          id={id}
          role="combobox"
          aria-expanded={expanded}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={expanded ? `${listId}-${activeIndex}` : undefined}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          autoComplete="off"
          spellCheck={false}
          value={value}
          placeholder={models.length ? 'search or type a model id' : 'model id or deployment name'}
          onChange={(e) => {
            onChange(e.target.value);
            setActive(0);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={onKeyDown}
        />
        {canRefresh ? (
          <button type="button" className="btn tiny" onClick={reload} disabled={!providerId || state?.status === 'loading'} aria-label={`Refresh the ${providerLabel} model list`}>
            {state?.status === 'loading' ? 'Loading…' : 'Refresh'}
          </button>
        ) : null}
      </div>
      {expanded ? (
        <ul id={listId} role="listbox" className="mpick-list" aria-label={`${providerLabel} models`}>
          {shown.map((m, i) => (
            <li
              key={m.id}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === activeIndex}
              className={i === activeIndex ? 'on' : undefined}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(m.id);
              }}
              onMouseEnter={() => setActive(i)}
            >
              <span className="mpick-id">{m.id}</span>
              {m.displayName && m.displayName !== m.id ? <span className="mpick-name">{m.displayName}</span> : null}
              <span className="mpick-meta">{optionMeta(m, devOnly)}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <span id={`${id}-status`} className={state?.status === 'failed' || list?.error ? 'hint mpick-warn' : 'hint'} role="status">
        {status}
      </span>
      <span id={`${id}-detail`} className="hint mpick-detail">
        {selected ? (
          <>
            {capabilityLine(selected) || 'no capability data'} · <span className={`mpick-price ${price!.kind}`}>{price!.text}</span>
          </>
        ) : value.trim() && list && !list.error ? (
          'not in the provider’s list · capabilities and price are checked when you save'
        ) : null}
      </span>
      {error ? (
        <span id={`${id}-error`} className="err" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}
