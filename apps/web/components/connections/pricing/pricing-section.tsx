import Link from 'next/link';
import { LifecycleActions } from '../lifecycle-actions';
import { DataTable } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { SecHead } from '@/components/ui/sec-head';
import type { CatalogStatus, MissingPrice } from '@/lib/api/model-catalog';
import type { Pricing, ProviderKindView } from '@/lib/api/models';
import { formatDateTime } from '@/lib/format';
import { formatPerMTok } from '../models/money';
import { formatTokens } from '../profiles/model-options';
import { connectionsHref } from '../url';
import { RefreshCatalogButton } from './catalog-actions';
import { MissingPrices } from './missing-prices';
import '@/app/styles/model-picker.css';

const TEMPLATE = 'minmax(0,1.3fr) minmax(0,0.8fr) 84px 88px 88px 88px 88px 110px';

/** Source pages for the catalog link next to a catalog price. */
const CATALOG_PAGES: Readonly<Record<string, string>> = {
  'models.dev': 'https://models.dev',
  litellm: 'https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json',
};

function CatalogLine({ catalog, timezone }: { catalog: CatalogStatus; timezone: string }) {
  return (
    <div className="catalog-status" role="note">
      <span>Catalog prices come from</span>
      {catalog.sources.map((s) => (
        <span key={s.source}>
          <a href={s.homepage} target="_blank" rel="noreferrer">
            {s.source}
          </a>{' '}
          · {s.origin === 'vendored' ? 'bundled copy' : 'fetched'} {formatDateTime(s.fetchedAt, timezone)}
          {s.lastError ? <span className="warn"> · last refresh failed ({s.lastError})</span> : null}
        </span>
      ))}
      <span>· refreshed every {catalog.refreshIntervalHours}h; your manual prices are never overwritten</span>
    </div>
  );
}

/**
 * Price table behind usage cost metadata (docs/05 §3, ADR-027): per 1M
 * tokens, per provider kind and model. Catalog rows were pre-filled from the
 * open-source model catalog (source + date) and follow its refreshes; editing
 * one makes it manual. Models in use without a price are listed below.
 */
export function PricingSection({
  pricing,
  kinds,
  timezone,
  missing,
  catalog,
}: {
  pricing: Pricing[];
  kinds: ProviderKindView[];
  timezone: string;
  missing: MissingPrice[] | null;
  catalog: CatalogStatus | null;
}) {
  const label = new Map(kinds.map((k) => [k.kind, k.label]));
  return (
    <section aria-labelledby="pricing-h" style={{ marginTop: 18 }}>
      <SecHead
        id="pricing-h"
        title="Model pricing"
        count={pricing.length}
        desc="per 1M tokens · used to cost every model call in telemetry"
        actions={
          <>
            {catalog?.refreshEnabled ? <RefreshCatalogButton /> : null}
            <Link className="btn tiny" href={connectionsHref({ tab: 'providers', dialog: 'pricing-new' })} scroll={false}>
              Add price
            </Link>
          </>
        }
      />
      {catalog ? <CatalogLine catalog={catalog} timezone={timezone} /> : null}
      <DataTable
        label="Model pricing"
        template={TEMPLATE}
        rows={pricing}
        rowKey={(p) => p.id}
        empty={
          <EmptyState title="No prices yet">
            Saving a model profile adds catalog prices for its models when the catalog knows them. Without a price row, usage is still recorded and shown as “no price”.
          </EmptyState>
        }
        columns={[
          {
            key: 'model',
            header: 'Model',
            cell: (p) => (
              <>
                <Link href={connectionsHref({ tab: 'providers', dialog: 'pricing-edit', id: p.id })} scroll={false} className="cell-link">
                  <b className="mono" style={{ fontSize: 12 }}>
                    {p.modelPattern}
                  </b>
                </Link>
                {p.origin === 'catalog' && p.catalogSource ? (
                  <span className="mono-sm price-src">
                    <a href={CATALOG_PAGES[p.catalogSource] ?? '#'} target="_blank" rel="noreferrer">
                      {p.catalogSource}
                    </a>
                    {p.catalogModelId && p.catalogModelId !== p.modelPattern ? ` · ${p.catalogModelId}` : ''}
                    {p.catalogFetchedAt ? ` · checked ${formatDateTime(p.catalogFetchedAt, timezone)}` : ''}
                  </span>
                ) : null}
                {p.tiers?.length ? (
                  <span className="mono-sm price-src">
                    higher rate above {formatTokens(p.tiers[0]!.aboveInputTokens)} input tokens: in {formatPerMTok(p.tiers[0]!.inputPerMTokMicros, p.currency)} · out{' '}
                    {formatPerMTok(p.tiers[0]!.outputPerMTokMicros, p.currency)}
                  </span>
                ) : null}
              </>
            ),
          },
          { key: 'provider', header: 'Provider', cell: (p) => <span className="mono-sm">{label.get(p.providerKind) ?? p.providerKind}</span> },
          {
            key: 'origin',
            header: 'Origin',
            cell: (p) =>
              p.origin === 'catalog' ? (
                <span className="schip accent" title="From the open-source model catalog; follows catalog refreshes until you edit it">
                  catalog
                </span>
              ) : (
                <span className="schip" title="Entered or edited by an admin; catalog refreshes never change it">
                  manual
                </span>
              ),
          },
          { key: 'in', header: 'Input', cell: (p) => <span className="mono">{formatPerMTok(p.inputPerMTokMicros, p.currency)}</span> },
          { key: 'out', header: 'Output', cell: (p) => <span className="mono">{formatPerMTok(p.outputPerMTokMicros, p.currency)}</span> },
          { key: 'read', header: 'Cache read', cell: (p) => <span className="mono">{formatPerMTok(p.cachedInputPerMTokMicros, p.currency)}</span> },
          { key: 'write', header: 'Cache write', cell: (p) => <span className="mono">{formatPerMTok(p.cacheWritePerMTokMicros, p.currency)}</span> },
          { key: 'from', header: 'Effective', cell: (p) => <span className="mono-sm">{formatDateTime(p.effectiveFrom, timezone)}</span> },
          {
            // A price a person enters is a draft that prices nothing until a second person approves it.
            key: 'approval',
            header: 'Approval',
            cell: (p) => (
              <LifecycleActions kind="model_pricing" id={p.id} name={`price for ${p.modelPattern}`} state={p.status === 'DRAFT' ? 'draft' : 'live'} approval={p.approval} activateLabel="Apply price" canStop={false} canDelete={false} />
            ),
          },
        ]}
      />
      {missing ? <MissingPrices missing={missing} kinds={kinds} /> : null}
    </section>
  );
}
