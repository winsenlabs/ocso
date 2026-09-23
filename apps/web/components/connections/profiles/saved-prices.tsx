'use client';

import Link from 'next/link';
import type { PriceCheck } from '@/lib/api/models';
import { connectionsHref } from '../url';

/** Worth showing after a save: something was priced from the catalog just now, or is not priced at all. */
export const needsPriceReview = (prices: readonly PriceCheck[]) => prices.some((p) => p.status !== 'priced');

/**
 * After a profile save (ADR-027): which targets were priced from the model
 * catalog just now, and which have no price at all — their usage shows
 * "no price" in telemetry until someone adds one.
 */
export function SavedPrices({ prices, canPricing }: { prices: readonly PriceCheck[]; canPricing: boolean }) {
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <p style={{ margin: 0 }}>
        <b>Profile saved.</b> Prices for its models:
      </p>
      <ul className="price-checks">
        {prices.map((p) => (
          <li key={`${p.providerKind}:${p.model}`}>
            <span className="mono">{p.model}</span>
            <span className="mono-sm">{p.providerKind.toLowerCase()}</span>
            <span className="sp" />
            {p.status === 'added' ? (
              <span className="schip accent" title="Pre-filled from the open-source model catalog; edit it under Model pricing to override">
                price added from {p.source ?? 'catalog'}
              </span>
            ) : p.status === 'priced' ? (
              <span className="schip good">{p.origin === 'catalog' ? 'catalog price' : 'manual price'}</span>
            ) : (
              <>
                <span className="schip warn">no price</span>
                {canPricing ? (
                  <Link className="btn tiny" href={connectionsHref({ tab: 'providers', dialog: 'pricing-new', kind: p.providerKind, model: p.model })} scroll={false}>
                    Add price
                  </Link>
                ) : (
                  <span className="mono-sm">ask a Tech admin to add one</span>
                )}
              </>
            )}
          </li>
        ))}
      </ul>
      <span className="mono-sm">Usage of a model without a price is recorded with its tokens and shown as “no price” — never as zero cost.</span>
    </div>
  );
}
