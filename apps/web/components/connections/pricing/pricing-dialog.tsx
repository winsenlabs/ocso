'use client';

import { useState, useTransition } from 'react';
import { AlertBanner } from '@/components/ui/alert-banner';
import { Modal } from '@/components/ui/modal';
import { deletePricingAction, savePricingAction } from '@/lib/actions/models';
import type { Pricing, ProviderKind, ProviderKindView } from '@/lib/api/models';
import { ConfirmAction } from '../confirm-action';
import { decimalFromMicros, microsFromDecimal } from '../models/money';
import { Input } from '../profiles/profile-fields';
import { useCloseTo } from '../routed-modal';

const PRICE_FIELDS = [
  { key: 'input', label: 'Input', required: true },
  { key: 'output', label: 'Output', required: true },
  { key: 'cacheRead', label: 'Cache read', required: false },
  { key: 'cacheWrite', label: 'Cache write', required: false },
] as const;
type PriceKey = (typeof PRICE_FIELDS)[number]['key'];

/** Add / edit a price row (POST, PATCH /v1/model-pricing). Amounts are per 1M tokens in the row's currency. */
export function PricingDialog({ kinds, row, closeHref }: { kinds: ProviderKindView[]; row: Pricing | null; closeHref: string }) {
  const close = useCloseTo(closeHref);
  const [kind, setKind] = useState<ProviderKind>(row?.providerKind ?? kinds[0]?.kind ?? 'OPENAI');
  const [pattern, setPattern] = useState(row?.modelPattern ?? '');
  const [currency, setCurrency] = useState(row?.currency ?? 'USD');
  const [prices, setPrices] = useState<Record<PriceKey, string>>({
    input: row ? decimalFromMicros(row.inputPerMTokMicros) : '',
    output: row ? decimalFromMicros(row.outputPerMTokMicros) : '',
    cacheRead: decimalFromMicros(row?.cachedInputPerMTokMicros ?? null),
    cacheWrite: decimalFromMicros(row?.cacheWritePerMTokMicros ?? null),
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function save() {
    const next: Record<string, string> = {};
    const micros = {} as Record<PriceKey, number | null>;
    for (const f of PRICE_FIELDS) {
      const value = microsFromDecimal(prices[f.key]);
      if (value === null && f.required) next[f.key] = 'Enter a price per 1M tokens';
      else if (value !== null && Number.isNaN(value)) next[f.key] = 'A decimal amount, e.g. 3 or 0.075';
      micros[f.key] = value;
    }
    if (!pattern.trim()) next['pattern'] = 'Enter a model id or a prefix ending in *';
    if (!/^[A-Z]{3}$/.test(currency.trim())) next['currency'] = 'Three-letter code, e.g. USD';
    setErrors(next);
    setMessage(null);
    if (Object.keys(next).length) return;
    start(async () => {
      const r = await savePricingAction(row?.id ?? null, {
        providerKind: kind,
        modelPattern: pattern.trim(),
        currency: currency.trim(),
        inputPerMTokMicros: micros.input!,
        outputPerMTokMicros: micros.output!,
        cachedInputPerMTokMicros: micros.cacheRead,
        cacheWritePerMTokMicros: micros.cacheWrite,
      });
      if (r.ok) close();
      else setMessage(r.message);
    });
  }

  return (
    <Modal
      title={row ? `Edit price · ${row.modelPattern}` : 'Add model price'}
      sub="per 1M tokens"
      onClose={close}
      maxWidth={560}
      footer={
        <>
          <span className="mono-sm">new usage is costed with the latest effective row</span>
          <span className="sp" />
          {row ? (
            <ConfirmAction label="Delete" buttonClass="btn danger" title={`Delete price for ${row.modelPattern}`} confirmLabel="Delete price" run={() => deletePricingAction(row.id)} onDone={close}>
              Future usage of matching models is recorded without a cost until another price row matches. Past usage keeps its recorded cost.
            </ConfirmAction>
          ) : null}
          <button type="button" className="btn" onClick={close}>
            Cancel
          </button>
          <button type="submit" form="pricing-form" className="btn accent" disabled={pending}>
            {pending ? 'Saving…' : row ? 'Save price' : 'Add price'}
          </button>
        </>
      }
    >
      <form
        id="pricing-form"
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
        <div className="fld-row">
          <div className="fld">
            <label htmlFor="pr-kind">Provider</label>
            <select id="pr-kind" value={kind} disabled={row !== null} onChange={(e) => setKind(e.target.value as ProviderKind)}>
              {kinds.map((k) => (
                <option key={k.kind} value={k.kind}>
                  {k.label}
                </option>
              ))}
            </select>
          </div>
          <Input id="pr-pattern" label="Model" value={pattern} onChange={setPattern} error={errors['pattern']} hint="exact id, or a prefix ending in * (claude-sonnet-4-*)" />
        </div>
        <Input id="pr-currency" label="Currency" value={currency} onChange={(v) => setCurrency(v.toUpperCase())} error={errors['currency']} />
        <div className="fld-row">
          {PRICE_FIELDS.map((f) => (
            <Input
              key={f.key}
              id={`pr-${f.key}`}
              label={`${f.label} per 1M tokens${f.required ? '' : ' (optional)'}`}
              value={prices[f.key]}
              onChange={(v) => setPrices((p) => ({ ...p, [f.key]: v }))}
              error={errors[f.key]}
            />
          ))}
        </div>
      </form>
    </Modal>
  );
}
