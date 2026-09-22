import Link from 'next/link';
import { CellTitle, DataTable } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { SecHead } from '@/components/ui/sec-head';
import type { Profile } from '@/lib/api/models';
import { formatCompact, formatLatency, formatPercent } from '@/lib/format';
import { cachingMode } from '../models/meta';
import { connectionsHref } from '../url';

const TEMPLATE = 'minmax(0,1fr) 108px minmax(0,1.2fr) minmax(0,110px) 74px 84px 170px';

function agentsCaption(p: Profile): string {
  if (!p.agents.length) return p.description ?? 'no agents yet';
  return p.agents.map((a) => (a.usage === 'MODEL' ? a.name : `${a.name} · ${a.usage.toLowerCase()}`)).join(', ');
}

function cacheCaption(p: Profile): string {
  if (p.cachePolicy === 'OFF') return 'caching off';
  const modes = [...new Set(p.targets.map((t) => cachingMode(t.caching)))];
  return `prefix${p.cacheTtl ? ` · ${p.cacheTtl}` : ''}${modes.length ? ` · ${modes.join(' / ')}` : ''}`;
}

/** Logical model profiles (design/04 table). Managers open the edit dialog; readers get a read-only view. */
export function ProfilesSection({ profiles, canManage, hasProviders }: { profiles: Profile[]; canManage: boolean; hasProviders: boolean }) {
  const open = (p: Profile) => connectionsHref({ tab: 'providers', dialog: canManage ? 'profile-edit' : 'profile-view', id: p.id });
  return (
    <section aria-labelledby="profiles-h" style={{ marginTop: 18 }}>
      <SecHead
        id="profiles-h"
        title="Logical model profiles"
        count={profiles.length}
        desc="agents reference profiles, never provider model IDs"
        actions={
          canManage ? (
            <Link className="btn tiny accent" href={connectionsHref({ tab: 'providers', dialog: 'profile-new' })} scroll={false}>
              New profile
            </Link>
          ) : null
        }
      />
      <DataTable
        label="Logical model profiles"
        template={TEMPLATE}
        rows={profiles}
        rowKey={(p) => p.id}
        empty={
          <EmptyState title="No model profiles yet">
            {hasProviders
              ? 'A profile names a primary model target, ordered fallbacks, generation limits and a cache policy. Agents pick a profile, never a model id.'
              : 'Configure a model provider first; profiles point at a provider’s model or deployment.'}
          </EmptyState>
        }
        columns={[
          {
            key: 'name',
            header: 'Profile',
            cell: (p) => (
              <Link href={open(p)} scroll={false} className="cell-link">
                <CellTitle title={p.name} caption={agentsCaption(p)} />
              </Link>
            ),
          },
          { key: 'provider', header: 'Provider', cell: (p) => <span className="mono-sm">{p.providerName ?? 'missing provider'}</span> },
          { key: 'model', header: 'Model mapping', cell: (p) => <span className="mono-sm">{`${p.model}${p.region ? ` · ${p.region}` : ''}`}</span> },
          {
            key: 'fallback',
            header: 'Fallback',
            cell: (p) => <span className="mono-sm">{p.fallbacks.length ? p.fallbacks.map((f) => f.providerName ?? 'missing').join(' → ') : 'none'}</span>,
          },
          { key: 'p95', header: 'p95', cell: (p) => <span className="mono">{formatLatency(p.stats24h?.p95LatencyMs)}</span> },
          {
            key: 'tokens',
            header: 'Tokens 24h',
            cell: (p) => <span className="mono">{p.stats24h ? formatCompact(p.stats24h.inputTokens + p.stats24h.outputTokens) : '—'}</span>,
          },
          {
            key: 'cache',
            header: 'Cache',
            cell: (p) => (
              <span>
                <span className="mono">{formatPercent(p.stats24h?.cacheReadRatio, 0)}</span>
                <span className="mono-sm" style={{ display: 'block' }}>
                  {cacheCaption(p)}
                </span>
              </span>
            ),
          },
        ]}
      />
    </section>
  );
}
