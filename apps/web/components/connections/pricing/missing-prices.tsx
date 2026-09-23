import Link from 'next/link';
import { DataTable } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { SecHead } from '@/components/ui/sec-head';
import type { MissingPrice } from '@/lib/api/model-catalog';
import type { ProviderKindView } from '@/lib/api/models';
import { formatNumber } from '@/lib/format';
import { formatPerMTok } from '../models/money';
import { connectionsHref } from '../url';
import { UseCatalogPriceButton } from './catalog-actions';

/**
 * "Prices" action (ADR-027): models profiles use, or that served requests in
 * the last 30 days, with no price row — their usage shows "no price". Offers
 * the catalog's price when it has one; otherwise "Add price" pre-fills the model.
 */
export function MissingPrices({ missing, kinds }: { missing: MissingPrice[]; kinds: ProviderKindView[] }) {
  const label = new Map(kinds.map((k) => [k.kind, k.label]));
  return (
    <section aria-labelledby="missing-prices-h" style={{ marginTop: 14 }}>
      <SecHead id="missing-prices-h" title="Models in use without a price" count={missing.length} desc="their usage is recorded as “no price”, never as zero" />
      <DataTable
        label="Models in use without a price"
        template="minmax(0,1.2fr) minmax(0,1fr) minmax(0,1.1fr) 230px"
        rows={missing}
        rowKey={(m) => `${m.providerKind}:${m.model}`}
        empty={<EmptyState title="Every model in use has a price">Profiles’ models and every model that served requests in the last 30 days are priced.</EmptyState>}
        columns={[
          {
            key: 'model',
            header: 'Model',
            cell: (m) => (
              <>
                <b className="mono" style={{ fontSize: 12 }}>
                  {m.model}
                </b>
                <span className="mono-sm" style={{ display: 'block' }}>
                  {label.get(m.providerKind) ?? m.providerKind}
                  {m.providers.length ? ` · ${m.providers.map((p) => p.name).join(', ')}` : ''}
                </span>
              </>
            ),
          },
          {
            key: 'use',
            header: 'Used by',
            cell: (m) => (
              <span className="mono-sm">
                {m.profiles.length ? m.profiles.join(', ') : 'no profile'} · {formatNumber(m.requests30d)} req · 30d
              </span>
            ),
          },
          {
            key: 'catalog',
            header: 'Catalog price',
            cell: (m) =>
              m.catalog ? (
                <span className="mono-sm">
                  in {formatPerMTok(m.catalog.inputPerMTokMicros, m.catalog.currency)} · out {formatPerMTok(m.catalog.outputPerMTokMicros, m.catalog.currency)}
                  <span style={{ display: 'block' }}>{m.catalog.source}</span>
                </span>
              ) : (
                <span className="mono-sm">not in the catalogs</span>
              ),
          },
          {
            key: 'act',
            header: '',
            cell: (m) => (
              <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                {m.catalog ? <UseCatalogPriceButton providerKind={m.providerKind} model={m.model} providerId={m.providers[0]?.id ?? null} /> : null}
                <Link className="btn tiny" href={connectionsHref({ tab: 'providers', dialog: 'pricing-new', kind: m.providerKind, model: m.model })} scroll={false}>
                  Add price
                </Link>
              </span>
            ),
          },
        ]}
      />
    </section>
  );
}
