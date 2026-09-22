import type { ChannelRegistry } from '@ocso/channels';
import type { ChannelContext } from '@ocso/prompt-compiler';

/** The channel columns the prompt needs. */
export interface PromptChannel {
  id: string;
  kind: string;
  name: string;
  settings: Record<string, unknown>;
}

/** What the prompt's channel block says about a channel (its name, plus the adapter's limits when known). */
export type ChannelContextResolver = (channel: PromptChannel) => ChannelContext;

/** Name and kind only: for callers without a channel registry (tests, tools that never reach a customer). */
export const basicChannelContext: ChannelContextResolver = (channel) => ({ kind: channel.kind, label: channel.name });

/** The adapter's declared limits (length, formatting, deliverable media) for the compiler's channel block. */
export function channelContextFrom(registry: ChannelRegistry): ChannelContextResolver {
  return (channel) => {
    if (!registry.has(channel.kind)) return basicChannelContext(channel);
    // Capabilities never need secrets; the settings are passed for adapters that vary by them.
    const caps = registry.get(channel.kind).capabilities({ id: channel.id, kind: channel.kind, name: channel.name, settings: channel.settings, secrets: {} });
    return { kind: channel.kind, label: channel.name, limits: { maxTextLength: caps.maxTextLength, markdown: caps.markdown, outboundParts: caps.outboundParts } };
  };
}
