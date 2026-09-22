import type { TemplateProviderPort, TemplateProviderSource } from '@ocso/application';
import type { ChannelRuntime } from './channel-runtime.js';

/**
 * Binds a channel's adapter template methods to its decrypted config for the
 * application's WhatsAppTemplateService (list, create + submit, status,
 * delete). Methods the adapter lacks stay undefined (e.g. web chat).
 */
export function templateProviderSource(runtime: ChannelRuntime): TemplateProviderSource {
  return async (channelId): Promise<TemplateProviderPort> => {
    const { adapter, config } = await runtime.load(channelId);
    return {
      listTemplates: adapter.listTemplates ? () => adapter.listTemplates!(config) : undefined,
      createTemplate: adapter.createTemplate ? (draft) => adapter.createTemplate!(config, draft) : undefined,
      templateStatus: adapter.templateStatus ? (id) => adapter.templateStatus!(config, id) : undefined,
      deleteTemplate: adapter.deleteTemplate ? (template) => adapter.deleteTemplate!(config, template) : undefined,
    };
  };
}
