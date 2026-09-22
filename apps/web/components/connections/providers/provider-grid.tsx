import Link from 'next/link';
import { KeyValue } from '@/components/ui/key-value';
import { ProviderCard } from '@/components/ui/provider-card';
import { StatusChip } from '@/components/ui/status-chip';
import type { Provider, ProviderKindView } from '@/lib/api/models';
import { formatAge, formatCompact, formatLatency, formatPercent } from '@/lib/format';
import { cachingSummary, providerMark, providerStatus, providerTone } from '../models/meta';
import { connectionsHref } from '../url';
import { ProviderCardFooter } from './provider-card-footer';

const KV = 'minmax(72px,84px) minmax(0,1fr)';

function authSummary(provider: Provider, kind: ProviderKindView | undefined): string {
  const authMode = provider.settings['authMode'];
  const mode = typeof authMode === 'string' ? `${authMode.toLowerCase().replace(/_/g, ' ')} · ` : '';
  const fields = kind?.credentials ?? [];
  if (!fields.length) return `${mode}no credentials needed`;
  const set = fields.filter((f) => f.name in provider.secretRefs).map((f) => f.label.toLowerCase());
  return `${mode}${set.length ? `${set.join(', ')} set` : 'credentials not set'}`;
}

function profilesSummary(provider: Provider): string {
  if (!provider.profiles.length) return '—';
  return provider.profiles.map((p) => (p.role === 'FALLBACK' ? `fallback for ${p.name}` : p.name)).join(', ');
}

function Card({ provider, kind, canManage }: { provider: Provider; kind: ProviderKindView | undefined; canManage: boolean }) {
  const s = provider.stats24h;
  const cache = s.cacheReadRatio === null ? '' : ` · ${formatPercent(s.cacheReadRatio, 0)} read`;
  const tested = provider.lastHealthAt
    ? `${formatAge(provider.lastHealthAt)} ago${provider.lastHealthLatencyMs !== null ? ` · ${formatLatency(provider.lastHealthLatencyMs)}` : ''}`
    : 'never';
  const items = [
    { k: 'region', v: `${provider.region ?? 'not set'}${provider.residencyZone ? ` · data in ${provider.residencyZone}` : ''}` },
    { k: 'auth', v: authSummary(provider, kind) },
    { k: 'profiles', v: profilesSummary(provider) },
    { k: 'caching', v: `${cachingSummary(kind)}${cache}` },
    { k: 'last test', v: tested },
  ];
  if (provider.lastError && provider.status !== 'OK') items.push({ k: 'last error', v: provider.lastError });
  const chips = (
    <>
      {provider.devOnly ? <StatusChip tone="accent">development only</StatusChip> : null}
      {!provider.policy.allowlisted ? <StatusChip tone="warn">not allowlisted</StatusChip> : null}
      {provider.policy.residency === 'VIOLATION' ? <StatusChip tone="warn">off-residency</StatusChip> : null}
      {provider.policy.residency === 'COMPLIANT' ? <span className="mono-sm">residency ok</span> : null}
      {s.errors > 0 ? <span className="mono-sm">{formatPercent(s.errorRate, 1)} errors 24h</span> : null}
    </>
  );
  const tone = providerTone(provider);
  return (
    <ProviderCard
      logo={providerMark(provider.kind, kind)}
      name={provider.name}
      status={providerStatus(provider)}
      {...(tone ? { tone } : {})}
      metrics={[
        { label: 'p95', value: formatLatency(s.p95LatencyMs) },
        { label: 'tokens 24h', value: formatCompact(s.inputTokens + s.outputTokens) },
      ]}
      footer={
        <ProviderCardFooter
          providerId={provider.id}
          canManage={canManage}
          editHref={connectionsHref({ tab: 'providers', dialog: 'provider-edit', id: provider.id })}
          chips={chips}
        />
      }
    >
      <span className="mono-sm">{provider.kindLabel}</span>
      <KeyValue template={KV} fontSize={12} items={items} />
    </ProviderCard>
  );
}

function UnconfiguredCard({ kind, canManage }: { kind: ProviderKindView; canManage: boolean }) {
  const creds = kind.credentials.map((c) => c.label.toLowerCase());
  return (
    <ProviderCard
      logo={providerMark(kind.kind, kind)}
      name={kind.label}
      status={{ tone: 'muted', label: 'not configured' }}
      footer={
        <div className="rowsplit">
          {canManage ? (
            <Link className="btn tiny" href={connectionsHref({ tab: 'providers', dialog: 'provider-new', kind: kind.kind })} scroll={false}>
              Configure
            </Link>
          ) : (
            <span className="mono-sm">not configured</span>
          )}
          <span className="sp" />
          {kind.devOnly ? <StatusChip tone="accent">development only</StatusChip> : null}
        </div>
      }
    >
      <KeyValue
        template={KV}
        fontSize={12}
        items={[
          { k: 'credentials', v: creds.length ? creds.join(', ') : 'none needed' },
          { k: 'caching', v: cachingSummary(kind) },
          { k: 'profiles', v: '—' },
        ]}
      />
    </ProviderCard>
  );
}

/** One card per configured provider, then one per provider kind this deployment offers but has not configured. */
export function ProviderGrid({ providers, kinds, canManage }: { providers: Provider[]; kinds: ProviderKindView[]; canManage: boolean }) {
  const byKind = new Map(kinds.map((k) => [k.kind, k]));
  const configured = new Set(providers.map((p) => p.kind));
  const unconfigured = kinds.filter((k) => !configured.has(k.kind));
  return (
    <div className="g g3 conn-grid" aria-label="Model providers" role="list">
      {providers.map((p) => (
        <div role="listitem" key={p.id} aria-label={p.name}>
          <Card provider={p} kind={byKind.get(p.kind)} canManage={canManage} />
        </div>
      ))}
      {unconfigured.map((k) => (
        <div role="listitem" key={k.kind} aria-label={k.label}>
          <UnconfiguredCard kind={k} canManage={canManage} />
        </div>
      ))}
    </div>
  );
}
