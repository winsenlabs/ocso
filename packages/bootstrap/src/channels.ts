import { createChannelEgress } from '@ocso/application';
import { ChannelRegistry, type ChannelFetch } from '@ocso/channels';
import type { DbOrTx } from '@ocso/db';
import { FIRST_PARTY_PLUGINS } from './first-party.js';
import { contributions, type OcsoPlugin } from './plugin.js';

/**
 * Channel adapters available in this deployment (registry, no switch; build
 * rule §4): every plugin's `channels`, in plugin order — the order of the
 * "Add channel" list. Each adapter gets the host's fetch and clock: by
 * default the SSRF-guarded channel egress (public https hosts, plus the Tech
 * Admin's internal-host allowlist when `db` is given), never the global fetch.
 */
export function createChannelRegistry(
  deps: { fetch?: ChannelFetch; now?: () => Date; db?: DbOrTx } = {},
  plugins: readonly OcsoPlugin[] = FIRST_PARTY_PLUGINS,
): ChannelRegistry {
  const adapterDeps = { fetch: deps.fetch ?? createChannelEgress({ db: deps.db }).fetch, now: deps.now ?? (() => new Date()) };
  const registry = new ChannelRegistry();
  for (const create of contributions(plugins, 'channels')) registry.register(create(adapterDeps));
  return registry;
}
