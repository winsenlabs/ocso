import Link from 'next/link';
import { EmptyState } from '@/components/ui/empty-state';
import { ProviderCard } from '@/components/ui/provider-card';
import { SecHead } from '@/components/ui/sec-head';
import type { ProviderKindView } from '@/lib/api/models';
import type { ProviderHealth } from '@/lib/api/telemetry';
import { formatCompact, formatLatency, formatPercent } from '@/lib/format';
import { providerMark } from '../connections/models/meta';
import { formatCost } from './cost';
import { cacheLabel, providerChip } from './system-meta';

function caption(p: ProviderHealth): string {
  const where = p.region ?? 'region not set';
  if (p.profiles.length === 0) return `${where} · configured, no profile assigned`;
  const names = p.profiles.map((pr) => (pr.role === 'FALLBACK' ? `fallback for ${pr.name}` : pr.name)).join(', ');
  return `${where} · ${p.profiles.length} profile${p.profiles.length === 1 ? '' : 's'} · ${names}`;
}

/**
 * Model provider health (design/03 .pvd grid): last-hour p95 latency and error
 * rate, today's tokens, prompt-cache read share (observed, per provider) and
 * cost. Providers are infrastructure; logical profiles point at them. Marks
 * come from the provider definitions (GET /v1/model-providers/kinds); a kind
 * without one gets a generic mark.
 */
export function ProviderHealthGrid({ providers, kinds, manageHref }: { providers: ProviderHealth[]; kinds: ProviderKindView[]; manageHref: string | null }) {
  const byKind = new Map(kinds.map((k) => [k.kind, k]));
  return (
    <>
      <SecHead
        title="Model provider health"
        count={`${providers.length} configured`}
        desc="provider is infrastructure; logical profiles point at it"
        actions={
          manageHref ? (
            <Link className="btn tiny ghost" href={manageHref}>
              Models
            </Link>
          ) : null
        }
      />
      {providers.length === 0 ? (
        <div style={{ marginBottom: 14 }}>
          <EmptyState title="No model provider configured">Add a provider under Integrations → Models; its health and cache hit rate appear here.</EmptyState>
        </div>
      ) : (
        <div className="g g3" role="list" aria-label="Model providers" style={{ marginBottom: 14 }}>
          {providers.map((p) => {
            const chip = providerChip(p);
            return (
              <div role="listitem" aria-label={p.name} key={p.providerId} style={{ display: 'grid' }}>
                <ProviderCard
                  logo={providerMark(p.kind, byKind.get(p.kind))}
                  name={p.name}
                  status={{ tone: chip.tone, label: chip.label }}
                  {...(chip.card ? { tone: chip.card } : {})}
                  metrics={[
                    { label: 'p95 latency · 1h', value: formatLatency(p.p95LatencyMs) },
                    { label: 'error rate · 1h', value: p.requests1h ? formatPercent(p.errorRate) : '—' },
                    { label: 'tokens today', value: formatCompact(p.tokensToday) },
                    { label: 'cache read', value: cacheLabel(p.cacheReadShare, p.cacheSupport) },
                  ]}
                  footer={
                    <div className="mono-sm">
                      {caption(p)}
                      {p.costTodayMicros !== null || p.unpricedRequestsToday ? ` · ${formatCost(p.costTodayMicros, p.currency, p.unpricedRequestsToday)} today` : ''}
                      {p.fallbacksFrom1h ? ` · ${p.fallbacksFrom1h} fell back 1h` : ''}
                      {p.cacheSupport === 'NOT_REPORTED' ? ' · no cache metrics reported' : ''}
                      {p.lastError && p.status !== 'OK' ? ` · ${p.lastError}` : ''}
                    </div>
                  }
                />
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
