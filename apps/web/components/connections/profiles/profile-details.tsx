import { KeyValue } from '@/components/ui/key-value';
import type { Profile } from '@/lib/api/models';
import { formatLatency } from '@/lib/format';
import { CAPABILITY_LABELS } from '../models/meta';
import { RoutedModal } from '../routed-modal';
import { TargetCachingTable } from './target-caching';

/** Read-only profile view for roles that can see profiles but not change them (e.g. CS Lead picking one for an agent). */
export function ProfileDetails({ profile, closeHref }: { profile: Profile; closeHref: string }) {
  const required = Object.entries(profile.requiredCapabilities)
    .filter(([, on]) => on)
    .map(([k]) => CAPABILITY_LABELS[k as keyof typeof CAPABILITY_LABELS] ?? k);
  return (
    <RoutedModal title={profile.name} sub="read only · managed by the Platform Tech Admin" closeHref={closeHref} maxWidth={720}>
      {profile.description ? <p style={{ margin: 0, fontSize: 12.5 }}>{profile.description}</p> : null}
      <KeyValue
        items={[
          { k: 'primary', v: `${profile.providerName ?? 'missing provider'} · ${profile.model}${profile.region ? ` · ${profile.region}` : ''}` },
          { k: 'fallbacks', v: profile.fallbacks.length ? profile.fallbacks.map((f) => `${f.providerName ?? 'missing'} · ${f.model}`).join(' → ') : 'none' },
          { k: 'generation', v: `max ${profile.maxOutputTokens} tokens · temperature ${profile.temperature ?? 'default'} · reasoning ${profile.reasoning ?? 'default'}` },
          { k: 'limits', v: `timeout ${formatLatency(profile.timeoutMs)} · ${profile.retries} retries · ${profile.retryBackoffMs}ms backoff` },
          { k: 'caching', v: profile.cachePolicy === 'OFF' ? 'off' : `prefix · ${profile.cacheTtl ?? 'provider default TTL'}` },
          { k: 'requires', v: required.length ? required.join(', ') : 'no specific capabilities' },
          { k: 'agents', v: profile.agents.length ? profile.agents.map((a) => `${a.name} (${a.usage.toLowerCase()})`).join(', ') : 'none' },
          { k: 'version', v: `config v${profile.configVersion}` },
        ]}
      />
      {profile.targets.length ? (
        <TargetCachingTable
          targets={profile.targets.map((t, i) => ({ key: `${i}`, role: t.role, providerName: t.providerName, model: t.model, capabilities: t.capabilities, caching: t.caching }))}
          cachePolicy={profile.cachePolicy}
          cacheTtl={profile.cacheTtl}
        />
      ) : null}
    </RoutedModal>
  );
}
