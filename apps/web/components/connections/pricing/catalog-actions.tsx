'use client';

import { useState, useTransition } from 'react';
import { addCatalogPriceAction, refreshCatalogAction } from '@/lib/actions/models';
import type { ProviderKind } from '@/lib/api/models';

/** "Use catalog price" for a model in use without a price (POST /v1/model-pricing/from-catalog). */
export function UseCatalogPriceButton({ providerKind, model, providerId }: { providerKind: ProviderKind; model: string; providerId: string | null }) {
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  return (
    <>
      <button
        type="button"
        className="btn tiny"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await addCatalogPriceAction(providerId ? { providerKind, model, providerId } : { providerKind, model });
            setMessage(r.ok ? null : r.message);
          })
        }
      >
        {pending ? 'Adding…' : 'Use catalog price'}
      </button>
      {message ? (
        <span className="err-text" role="alert">
          {message}
        </span>
      ) : null}
    </>
  );
}

/** Download models.dev + LiteLLM now; catalog-origin prices follow. */
export function RefreshCatalogButton() {
  const [pending, start] = useTransition();
  const [note, setNote] = useState<string | null>(null);
  return (
    <>
      <button
        type="button"
        className="btn tiny"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await refreshCatalogAction();
            if (!r.ok) setNote(r.message);
            else {
              const failed = r.data.sources.filter((s) => !s.ok);
              const p = r.data.prices;
              setNote(
                `${failed.length ? `Not reachable: ${failed.map((s) => `${s.source} (${s.error ?? 'failed'})`).join(', ')}; kept the previous copy. ` : 'Catalog refreshed. '}` +
                  `${p.updated} catalog price${p.updated === 1 ? '' : 's'} changed, ${p.unchanged} unchanged${p.notInCatalog ? `, ${p.notInCatalog} no longer in the catalog (kept)` : ''}.`,
              );
            }
          })
        }
      >
        {pending ? 'Refreshing…' : 'Refresh catalog'}
      </button>
      {note ? (
        <span className="mono-sm" role="status">
          {note}
        </span>
      ) : null}
    </>
  );
}
