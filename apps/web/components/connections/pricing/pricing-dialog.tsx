'use client';

import { useState, useTransition } from 'react';
import { AlertBanner } from '@/components/ui/alert-banner';
import { Modal } from '@/components/ui/modal';
import { deletePricingAction, savePricingAction } from '@/lib/actions/models';
import type { CatalogPrice } from '@/lib/api/model-catalog';
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

interface Props {
  kinds: ProviderKindView[];
  row: Pricing | null;
  closeHref: string;
  /** New row opened from "no price": the model to price, and the catalog's offer when it has one. */
  initial?: { kind: ProviderKind; model: string; suggestion: CatalogPrice | null } | undefined;
}

/**
 * Add / edit a price row (POST, PATCH /v1/model-pricing). Amounts are per 1M
 * tokens in the row's currency. Editing a catalog row overrides it (manual).
 */
export function PricingDialog({ kinds, row, closeHref, initial }: Props) {
  const close = useCloseTo(closeHref);
  const offer = row ? null : (initial?.suggestion ?? null);
  const source = row ?? offer;
  const [kind, setKind] = useState<ProviderKind>(row?.providerKind ?? initial?.kind ?? kinds[0]?.kind ?? '');
  const [pattern, setPattern] = useState(row?.modelPattern ?? initial?.model ?? '');
  const [currency, setCurrency] = useState(row?.currency ?? offer?.currency ?? 'USD');
  const [prices, setPrices] = useState<Record<PriceKey, string>>({
    input: source ? decimalFromMicros(source.inputPerMTokMicros) : '',
    output: source ? decimalFromMicros(source.outputPerMTokMicros) : '',
    cacheRead: decimalFromMicros(source?.cachedInputPerMTokMicros ?? null),
    cacheWrite: decimalFromMicros(source?.cacheWritePerMTokMicros ?? null),
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
    if (!kind) next['kind'] = 'Choose a provider';
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
        {row?.origin === 'catalog' ? (
          <AlertBanner tone="info" style={{ margin: 0 }}>
            From the {row.catalogSource ?? 'model'} catalog and kept current by catalog refreshes. Saving an edit makes it a manual price that refreshes never change.
          </AlertBanner>
        ) : offer ? (
          <AlertBanner tone="info" style={{ margin: 0 }}>
            Pre-filled from {offer.source} (fetched {offer.fetchedAt.slice(0, 10)}). Saving stores it as your manual price; “Use catalog price” in the list keeps it following the catalog instead.
          </AlertBanner>
        ) : initial ? (
          <AlertBanner tone="warn" style={{ margin: 0 }}>
            The model catalogs have no price for {initial.model}. Enter the provider’s published rates per 1M tokens.
          </AlertBanner>
        ) : null}
        <div className="fld-row">
          <div className="fld">
            <label htmlFor="pr-kind">Provider</label>
            <select
              id="pr-kind"
              value={kind}
              disabled={row !== null}
              onChange={(e) => setKind(e.target.value)}
              aria-invalid={errors['kind'] ? true : undefined}
              aria-describedby={errors['kind'] ? 'pr-kind-error' : undefined}
            >
              {/* A stored row keeps its kind even when this deployment no longer registers it. */}
              {row && !kinds.some((k) => k.kind === row.providerKind) ? <option value={row.providerKind}>{row.providerKind}</option> : null}
              {kinds.map((k) => (
                <option key={k.kind} value={k.kind}>
                  {k.label}
                </option>
              ))}
            </select>
            {errors['kind'] ? (
              <span id="pr-kind-error" className="err" role="alert">
                {errors['kind']}
              </span>
            ) : null}
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
