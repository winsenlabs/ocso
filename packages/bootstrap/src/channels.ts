import { ChannelRegistry, createWebChatAdapter, createWhatsAppAdapter } from '@ocso/channels';

/** Channel adapters available in this deployment (registry, no switch; build rule §4). */
export function createChannelRegistry(deps: { fetch?: typeof fetch; now?: () => Date } = {}): ChannelRegistry {
  const adapterDeps = { fetch: deps.fetch ?? fetch, now: deps.now ?? (() => new Date()) };
  return new ChannelRegistry().register(createWhatsAppAdapter(adapterDeps)).register(createWebChatAdapter(adapterDeps));
}
