import { ChannelRegistry, createTwilioWhatsAppAdapter, createWebChatAdapter, createWhatsAppAdapter } from '@ocso/channels';

/**
 * Channel adapters available in this deployment (registry, no switch; build rule §4).
 * Order is the order of the "Add channel" list: Twilio is the primary WhatsApp path,
 * the direct Meta Cloud API adapter the alternative.
 */
export function createChannelRegistry(deps: { fetch?: typeof fetch; now?: () => Date } = {}): ChannelRegistry {
  const adapterDeps = { fetch: deps.fetch ?? fetch, now: deps.now ?? (() => new Date()) };
  return new ChannelRegistry()
    .register(createTwilioWhatsAppAdapter(adapterDeps))
    .register(createWhatsAppAdapter(adapterDeps))
    .register(createWebChatAdapter(adapterDeps));
}
