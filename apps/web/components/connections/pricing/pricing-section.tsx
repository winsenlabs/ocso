import Link from 'next/link';
import { DataTable } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { SecHead } from '@/components/ui/sec-head';
import type { Pricing, ProviderKindView } from '@/lib/api/models';
import { formatDateTime } from '@/lib/format';
import { formatPerMTok } from '../models/money';
import { connectionsHref } from '../url';

const TEMPLATE = 'minmax(0,1.3fr) minmax(0,0.9fr) 92px 92px 92px 92px 110px';

/** Price table behind usage cost metadata (docs/05 §3): per 1M tokens, per provider kind and model pattern. */
export function PricingSection({ pricing, kinds, timezone }: { pricing: Pricing[]; kinds: ProviderKindView[]; timezone: string }) {
  const label = new Map(kinds.map((k) => [k.kind, k.label]));
  return (
    <section aria-labelledby="pricing-h" style={{ marginTop: 18 }}>
      <SecHead
        id="pricing-h"
        title="Model pricing"
        count={pricing.length}
        desc="per 1M tokens · used to cost every model call in telemetry"
        actions={
          <Link className="btn tiny" href={connectionsHref({ tab: 'providers', dialog: 'pricing-new' })} scroll={false}>
            Add price
          </Link>
        }
      />
      <DataTable
        label="Model pricing"
        template={TEMPLATE}
        rows={pricing}
        rowKey={(p) => p.id}
        empty={
          <EmptyState title="No prices yet">
            Without a price row, usage is still recorded but has no cost. Add input, output, cache-read and cache-write prices per model id or prefix
            (e.g. claude-sonnet-4-*).
          </EmptyState>
        }
        columns={[
          {
            key: 'model',
            header: 'Model',
            cell: (p) => (
              <Link href={connectionsHref({ tab: 'providers', dialog: 'pricing-edit', id: p.id })} scroll={false} className="cell-link">
                <b className="mono" style={{ fontSize: 12 }}>
                  {p.modelPattern}
                </b>
              </Link>
            ),
          },
          { key: 'provider', header: 'Provider', cell: (p) => <span className="mono-sm">{label.get(p.providerKind) ?? p.providerKind}</span> },
          { key: 'in', header: 'Input', cell: (p) => <span className="mono">{formatPerMTok(p.inputPerMTokMicros, p.currency)}</span> },
          { key: 'out', header: 'Output', cell: (p) => <span className="mono">{formatPerMTok(p.outputPerMTokMicros, p.currency)}</span> },
          { key: 'read', header: 'Cache read', cell: (p) => <span className="mono">{formatPerMTok(p.cachedInputPerMTokMicros, p.currency)}</span> },
          { key: 'write', header: 'Cache write', cell: (p) => <span className="mono">{formatPerMTok(p.cacheWritePerMTokMicros, p.currency)}</span> },
          { key: 'from', header: 'Effective', cell: (p) => <span className="mono-sm">{formatDateTime(p.effectiveFrom, timezone)}</span> },
        ]}
      />
    </section>
  );
}
