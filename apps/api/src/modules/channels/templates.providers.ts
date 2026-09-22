import type { Provider } from '@nestjs/common';
import { MessageTemplateService, type SessionWindowHours } from '@ocso/application';
import { ChannelRuntime, templateProviderSource } from '@ocso/agent-runtime';
import type { ChannelRegistry } from '@ocso/channels';
import type { Db } from '@ocso/db';
import { CHANNEL_REGISTRY, DB } from '../../infrastructure/tokens.js';

/** `SessionWindowHours` for the API: the channel adapter's declared window (null = none). */
export const SESSION_WINDOW_HOURS = Symbol('SESSION_WINDOW_HOURS');

export function windowHoursFrom(registry: ChannelRegistry): SessionWindowHours {
  return (channel) => {
    if (!registry.has(channel.kind)) return null;
    // Capabilities never need secrets; the settings are passed for adapters that vary by them.
    return registry.get(channel.kind).capabilities({ id: channel.id, kind: channel.kind, name: channel.name, settings: channel.settings, secrets: {} }).sessionWindowHours;
  };
}

export const TEMPLATE_PROVIDERS: Provider[] = [
  { provide: SESSION_WINDOW_HOURS, inject: [CHANNEL_REGISTRY], useFactory: (registry: ChannelRegistry) => windowHoursFrom(registry) },
  {
    provide: MessageTemplateService,
    inject: [DB, ChannelRuntime],
    useFactory: (db: Db, runtime: ChannelRuntime) => new MessageTemplateService(db, templateProviderSource(runtime)),
  },
];
